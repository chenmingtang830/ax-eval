/**
 * Score a profile's Phase-0 discovery funnel (behavioral AEO). Discovery is no
 * longer a separate run — each profile (floor, ceiling) cold-starts and reports
 * its own funnel, which we score against what the official docs *should* let an
 * agent find. The L1-L4 tasks are the outcome, so a per-discovery `outcome`
 * round-trip is optional (scored only if a spec still carries one).
 *
 * Honesty caveat: searches/urls/endpoint are self-reported by the host agent
 * (v0). The optional outcome check is NOT — it re-GETs against the live API.
 */
import { readFileSync } from "node:fs";
import { BearerClient, resolveDotted, type ApiStyle } from "../http/client.js";
import { applyNs } from "../harness/executor.js";
import type { DiscoverySpec } from "../schemas.js";
import type { SurfaceId } from "../surface/types.js";

/** Per-surface label for the "authoritative discovery source" the `official`
 *  metric checks the agent reached. For the API surface this is the docs site;
 *  for CLI/SDK/MCP the agent may instead discover locally (--help / SDK ref /
 *  tools/list), which is legitimate and must not be scored as a miss. */
const DISCOVERY_SOURCE: Record<SurfaceId, string> = {
  api: "official docs",
  cli: "--help / official CLI docs",
  sdk: "SDK reference / type defs",
  mcp: "the server's tools/list",
};

export interface DiscoveryResult {
  ns?: string;
  completed_gid?: string | null;
  searches?: string[];
  urls_visited?: string[];
  endpoint_used?: string;
  auth_scheme_found?: string;
  /** True when the agent objectively reached the surface's authoritative LOCAL
   *  discovery source (CLI `--help`, SDK reference/import, or MCP `tools/list`).
   *  Lets `official` pass for non-API surfaces even if the agent also web-searched
   *  — those surfaces are self-describing, so listing/inspecting them IS discovery. */
  inspected_local_source?: boolean;
  notes?: string;
}

export interface DiscoveryMetric {
  id: "official" | "canonical" | "hops" | "misled" | "auth" | "outcome";
  passed: boolean;
  detail: string;
}

export interface DiscoveryReport {
  ns?: string;
  hops: number;
  metrics: DiscoveryMetric[];
}

export function loadDiscoveryResult(path: string): DiscoveryResult {
  return JSON.parse(readFileSync(path, "utf8")) as DiscoveryResult;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function isOfficial(url: string, domains: string[]): boolean {
  const h = host(url).toLowerCase();
  return domains.some((d) => h === d.toLowerCase() || h.endsWith(`.${d.toLowerCase()}`));
}

/** Normalize "post  /tasks/" → "POST /tasks" for the canonical comparison. */
function normEndpoint(e: string): string {
  const m = e.trim().match(/^([a-z]+)\s+(\S+)/i);
  if (!m) return e.trim().toLowerCase();
  return `${m[1]!.toUpperCase()} ${m[2]!.replace(/\/+$/, "")}`;
}

/**
 * Classify an auth phrasing into a coarse scheme bucket, so an agent that
 * reports "Authorization: Bearer <PAT>" is scored as matching an expected
 * "Bearer personal access token" (it discovered the right scheme) instead of
 * failing a brittle literal-substring check.
 */
function authScheme(s: string): string {
  const t = s.toLowerCase();
  if (/bearer|personal access token|\bpat\b/.test(t)) return "bearer/pat";
  if (/oauth/.test(t)) return "oauth";
  if (/basic/.test(t)) return "basic";
  if (/api[\s_-]?key/.test(t)) return "apikey";
  return t.trim() ? "other" : "";
}

export interface ScoreDiscoveryOptions {
  /** Which surface produced this funnel. Generalizes "reached official docs" to
   *  "reached the authoritative discovery source for this surface". Defaults to
   *  "api" so the legacy behavior is unchanged. */
  surface?: SurfaceId;
  /** The pack's API style. GraphQL targets expose ONE endpoint for everything, so
   *  the "canonical endpoint" is really the mutation NAME — a METHOD+path string
   *  match (the REST check) can never match it. Defaults to "rest" (legacy). */
  apiStyle?: ApiStyle;
}

/** GraphQL canonical is an operation name ("mutation create_item" → "create_item"),
 *  not a METHOD+path; strip a leading query/mutation keyword for name matching. */
function graphqlOpName(canonicalEndpoint: string): string {
  return canonicalEndpoint
    .trim()
    .replace(/^(mutation|query|subscription)\s+/i, "")
    .toLowerCase();
}

export async function scoreDiscovery(
  spec: DiscoverySpec,
  result: DiscoveryResult,
  client: BearerClient,
  opts: ScoreDiscoveryOptions = {},
): Promise<DiscoveryReport> {
  const surface = opts.surface ?? "api";
  const isGraphql = (opts.apiStyle ?? "rest") === "graphql";
  // CLI/SDK/MCP can be discovered without the web (inspect --help, read the SDK
  // types, or list MCP tools), so a run that found the artifact locally must not
  // be marked as "never reached the authoritative source".
  const webOptional = surface !== "api";
  const ns = result.ns;
  const urls = result.urls_visited ?? [];
  const searches = result.searches ?? [];
  const used = result.endpoint_used ? normEndpoint(result.endpoint_used) : "";
  const metrics: DiscoveryMetric[] = [];

  // 1) Reached the authoritative discovery source for this surface.
  const officialHits = urls.filter((u) => isOfficial(u, spec.official_domains));
  // Local discovery counts when the agent objectively inspected the surface's
  // self-describing source (preferred signal), or — as a fallback for self-report
  // funnels that don't carry it — when it used the artifact without any web pages.
  const discoveredLocally =
    webOptional && (result.inspected_local_source === true || (urls.length === 0 && !!used));
  metrics.push({
    id: "official",
    passed: officialHits.length > 0 || discoveredLocally,
    detail: officialHits.length
      ? `visited official domain(s): ${[...new Set(officialHits.map(host))].join(", ")}`
      : discoveredLocally
        ? `discovered locally via ${DISCOVERY_SOURCE[surface]} (no web search needed)`
        : `never reached ${DISCOVERY_SOURCE[surface]} (${spec.official_domains.join(", ") || "none configured"})`,
  });

  // 2) Found the canonical create action.
  //  - REST API surface: strict match against the canonical endpoint ("POST /tasks").
  //  - GraphQL API surface: every operation is a POST to ONE endpoint, so the
  //    canonical "endpoint" is the mutation NAME ("create_item"). A METHOD+path
  //    comparison can never match what an agent reports (e.g. "POST /v2 (mutation
  //    create_item)"), so match the operation name inside the reported string.
  //  - CLI/SDK/MCP: the pack's canonical_endpoint is API-shaped, so a literal
  //    comparison to a command/method/tool name would be apples-to-oranges. We
  //    instead require the agent to have identified AND used a concrete create
  //    action on that surface (non-empty `used`); the real correctness gate for
  //    non-API surfaces is the independent round-trip oracle, not this string.
  const canonical = normEndpoint(spec.canonical_endpoint);
  const opName = graphqlOpName(spec.canonical_endpoint);
  const usedRaw = (result.endpoint_used ?? "").toLowerCase();
  let canonicalPassed: boolean;
  let canonicalDetail: string;
  if (webOptional) {
    canonicalPassed = !!used;
    canonicalDetail = `used=${used || "(none)"} (${surface}: canonical compared via round-trip oracle, not endpoint string)`;
  } else if (isGraphql) {
    canonicalPassed = !!opName && usedRaw.includes(opName);
    canonicalDetail = `used=${result.endpoint_used || "(none)"} canonical-op=${opName || "(none)"} (graphql: matched by mutation name; single endpoint)`;
  } else {
    canonicalPassed = !!used && used === canonical;
    canonicalDetail = `used=${used || "(none)"} canonical=${canonical}`;
  }
  metrics.push({ id: "canonical", passed: canonicalPassed, detail: canonicalDetail });

  // 3) Hops to discovery (efficiency). Heuristic target: ≤ 3 searches.
  const hops = searches.length;
  metrics.push({
    id: "hops",
    passed: hops > 0 && hops <= 3,
    detail: `${hops} search(es), ${urls.length} page(s) visited`,
  });

  // 4) Misled by an outdated / non-official source.
  const haystack = [result.endpoint_used, result.notes, ...urls].filter(Boolean).join(" ").toLowerCase();
  const hitMarker = spec.deprecated_markers.find((m) => haystack.includes(m.toLowerCase()));
  const firstUrl = urls[0];
  const startedNonOfficial = !!firstUrl && !isOfficial(firstUrl, spec.official_domains);
  const misled = !!hitMarker || startedNonOfficial;
  metrics.push({
    id: "misled",
    passed: !misled,
    detail: hitMarker
      ? `hit deprecated marker "${hitMarker}"`
      : startedNonOfficial
        ? `first landing was non-official: ${host(firstUrl)}`
        : "no misleading/outdated source detected",
  });

  // 5) Discovered the auth scheme. Compare coarse scheme buckets, not literal
  // strings, so a correct "Authorization: Bearer <PAT>" phrasing matches an
  // expected "Bearer personal access token".
  const foundScheme = authScheme(result.auth_scheme_found ?? "");
  const expectedScheme = authScheme(spec.auth_scheme);
  const authOk =
    !!foundScheme && foundScheme !== "other" && foundScheme === expectedScheme;
  metrics.push({
    id: "auth",
    passed: authOk,
    detail: `found=${result.auth_scheme_found || "(none)"} [${foundScheme || "?"}] expected=${spec.auth_scheme || "(none)"} [${expectedScheme || "?"}]`,
  });

  // 6) Outcome: independent round-trip on whatever it created.
  if (spec.outcome?.readPathTemplate && spec.outcome.assertField) {
    const gid = result.completed_gid;
    if (!gid) {
      metrics.push({ id: "outcome", passed: false, detail: "no gid reported (goal not completed)" });
    } else {
      const path = spec.outcome.readPathTemplate.replace("{gid}", encodeURIComponent(gid));
      const expectedVal =
        typeof spec.outcome.expected === "string" && ns
          ? applyNs(spec.outcome.expected, ns)
          : spec.outcome.expected;
      try {
        const body = await client.get<Record<string, unknown>>(path, { opt_fields: spec.outcome.assertField });
        const actual = resolveDotted(body, spec.outcome.assertField);
        metrics.push({
          id: "outcome",
          passed: actual === expectedVal,
          detail: `${spec.outcome.assertField}=${JSON.stringify(actual)} expected=${JSON.stringify(expectedVal)}`,
        });
      } catch (err) {
        metrics.push({ id: "outcome", passed: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { ns, hops, metrics };
}
