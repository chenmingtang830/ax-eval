/**
 * Static audit **v2** — agent-style discovery over the docs graph.
 *
 * v0 (`checks.ts`) probes fixed conventional paths on the marketing root
 * (`/llms.txt`, `/openapi.json`, …). Real agents don't do that: they land on a
 * page, read it, and *follow links* into the docs/developer hub, picking up the
 * OpenAPI spec, MCP descriptor, SDK, and auth scheme along the way. v2 models
 * that: a bounded breadth-first crawl from entry point(s), running surface
 * detectors on every fetched page, and crediting a surface only if it's actually
 * reachable by following links — recording at which hop it was found.
 *
 * This aligns the static layer with the behavioral discovery funnel: both now
 * ask "is this findable by crawling from a cold start?", not "does it sit at the
 * path we happened to hard-code?".
 */
import { Fetcher, type FetcherOptions } from "./fetcher.js";
import type { Weight } from "./types.js";

export interface DiscoverOptions extends FetcherOptions {
  /** Where the crawl starts. Defaults to [site]. */
  entryPoints?: string[];
  /** Max pages to fetch (politeness + bounded latency). Default 25. */
  maxPages?: number;
  /** Max link hops from an entry point before stopping expansion. Default 2. */
  maxDepth?: number;
  /** Injectable fetcher (tests); defaults to a real `Fetcher` from `opts`. */
  fetcher?: Pick<Fetcher, "get">;
}

export interface SurfaceFinding {
  id: string;
  label: string;
  weight: Weight;
  found: boolean;
  /** Hops from an entry point at which it was first found (0 = on an entry). */
  hop?: number;
  /** The page/URL the evidence came from. */
  via?: string;
  detail: string;
}

export interface DiscoveryAudit {
  site: string;
  entryPoints: string[];
  pagesCrawled: number;
  /** 0–100: weighted share of surfaces discoverable by crawling. */
  score: number;
  surfaces: SurfaceFinding[];
  source: "live" | "fixture" | "mixed";
}

interface Page {
  url: string;
  body: string;
  hop: number;
}

interface SurfaceDetector {
  id: string;
  label: string;
  weight: Weight;
  /** Evidence on THIS page, or null. */
  detect(page: Page): { detail: string } | null;
}

/** A scanned page's body slice we look at (cap to keep regexes cheap). */
function head(body: string, n = 8000): string {
  return body.slice(0, n);
}

const DETECTORS: SurfaceDetector[] = [
  {
    id: "llms-txt",
    label: "llms.txt reachable",
    weight: 3,
    detect: (p) =>
      /\/llms\.txt$/i.test(p.url) && p.body.trim().length > 0 ? { detail: `llms.txt at ${p.url}` } : null,
  },
  {
    id: "agents-md",
    label: "AGENTS.md reachable",
    weight: 2,
    detect: (p) =>
      /\/agents\.md$/i.test(p.url) && p.body.trim().length > 0 ? { detail: `AGENTS.md at ${p.url}` } : null,
  },
  {
    id: "markdown-docs",
    label: "Machine-readable docs index reachable",
    weight: 2,
    detect: (p) =>
      /\/llms-full\.txt$/i.test(p.url) && p.body.trim().length > 0
        ? { detail: `llms-full.txt at ${p.url}` }
        : null,
  },
  {
    id: "openapi",
    label: "OpenAPI spec discoverable by crawl",
    weight: 3,
    detect: (p) => {
      const isSpecUrl = /(openapi|swagger)[^/]*\.(json|ya?ml)(\?|$)/i.test(p.url) || /\/openapi(\?|$)/i.test(p.url);
      if (isSpecUrl && /["']?(openapi|swagger)["']?\s*[:=]/i.test(head(p.body))) {
        return { detail: `OpenAPI spec at ${p.url}` };
      }
      return null;
    },
  },
  {
    id: "mcp-server",
    label: "MCP server discoverable",
    weight: 2,
    detect: (p) => {
      if (/\.well-known\/mcp\.json$/i.test(p.url) && /\b(mcp|tools|server)\b/i.test(head(p.body))) {
        return { detail: `MCP descriptor at ${p.url}` };
      }
      if (/\bmodel context protocol\b|\bmcp server\b/i.test(head(p.body))) {
        return { detail: `MCP referenced on ${p.url}` };
      }
      return null;
    },
  },
  {
    id: "official-sdk",
    label: "Official SDK discoverable",
    weight: 1,
    detect: (p) =>
      /\bnpm install\b|\bpip install\b|\bclient librar(y|ies)\b|[\w.-]+\/[\w.-]+-(sdk|client)\b|\bofficial sdk\b/i.test(
        head(p.body),
      )
        ? { detail: `SDK referenced on ${p.url}` }
        : null,
  },
  {
    id: "auth-discovery",
    label: "Auth scheme discoverable by crawl",
    weight: 2,
    detect: (p) => {
      if (
        /\.well-known\/(oauth-authorization-server|openid-configuration)$/i.test(p.url) &&
        /authorization_endpoint|token_endpoint|issuer/i.test(head(p.body))
      ) {
        return { detail: `auth metadata at ${p.url}` };
      }
      if (/\boauth\b|personal access token|authorization:\s*bearer|\bbearer token\b|\bapi key\b/i.test(head(p.body))) {
        return { detail: `auth scheme documented on ${p.url}` };
      }
      return null;
    },
  },
];

/** Links that are terminal artifacts worth fetching even if cross-host or past
 *  the depth limit (an agent would open the spec/descriptor it sees linked). */
function isArtifactLink(url: string): boolean {
  return /\/(llms\.txt|llms-full\.txt|agents\.md)$/i.test(url) || /(openapi|swagger)[^/]*\.(json|ya?ml)(\?|$)/i.test(url) || /\.well-known\/(mcp\.json|openapi\.json|oauth-authorization-server|openid-configuration)$/i.test(url);
}

/** Pull candidate links from a page: HTML href/src, markdown links, bare URLs. */
function extractLinks(body: string, base: string): string[] {
  const out = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const v = raw.trim();
    if (!v || v.startsWith("#") || v.startsWith("mailto:") || v.startsWith("javascript:")) return;
    try {
      out.add(new URL(v, base).toString());
    } catch {
      /* ignore unparseable */
    }
  };
  for (const m of body.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) add(m[1]); // markdown [x](url)
  for (const m of body.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) add(m[0]);
  return [...out];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export async function discoverSurfaces(site: string, opts: DiscoverOptions = {}): Promise<DiscoveryAudit> {
  const fetcher = opts.fetcher ?? new Fetcher(opts);
  const maxPages = opts.maxPages ?? 25;
  const maxDepth = opts.maxDepth ?? 2;
  const entryPoints = opts.entryPoints?.length ? opts.entryPoints : [site];
  const rootHost = hostOf(entryPoints[0] ?? site);

  const queue: { url: string; hop: number }[] = entryPoints.map((u) => ({ url: u, hop: 0 }));
  const seen = new Set(queue.map((q) => q.url));
  const findings = new Map<string, SurfaceFinding>();
  const sources = new Set<"live" | "fixture">();
  let pagesCrawled = 0;

  while (queue.length > 0 && pagesCrawled < maxPages) {
    const { url, hop } = queue.shift()!;
    const r = await fetcher.get(url);
    if (r.status === 0) continue; // unreachable; don't count as a crawled page
    pagesCrawled++;
    sources.add(r.source);
    const page: Page = { url, body: r.body, hop };

    for (const det of DETECTORS) {
      const existing = findings.get(det.id);
      if (existing?.found) continue; // keep the earliest (lowest-hop) hit
      const hit = det.detect(page);
      if (hit) {
        findings.set(det.id, {
          id: det.id,
          label: det.label,
          weight: det.weight,
          found: true,
          hop,
          via: url,
          detail: hit.detail,
        });
      }
    }

    if (!r.ok) continue; // a 404 page has no trustworthy links to follow
    for (const link of extractLinks(r.body, url)) {
      if (seen.has(link)) continue;
      const sameHost = hostOf(link) === rootHost;
      const artifact = isArtifactLink(link);
      if (artifact) {
        seen.add(link);
        queue.push({ url: link, hop: hop + 1 }); // leaf: fetched but not expanded
      } else if (sameHost && hop < maxDepth) {
        seen.add(link);
        queue.push({ url: link, hop: hop + 1 });
      }
    }
  }

  // Surfaces never found are recorded as not-discoverable (counts against score).
  const surfaces: SurfaceFinding[] = DETECTORS.map(
    (d) =>
      findings.get(d.id) ?? {
        id: d.id,
        label: d.label,
        weight: d.weight,
        found: false,
        detail: "not reachable by crawling from entry point(s)",
      },
  );

  const totalWeight = surfaces.reduce((s, f) => s + f.weight, 0);
  const earned = surfaces.reduce((s, f) => s + (f.found ? f.weight : 0), 0);
  const score = pagesCrawled === 0 ? 0 : Math.round((earned / totalWeight) * 100);

  const source: DiscoveryAudit["source"] =
    sources.size === 2 ? "mixed" : sources.has("fixture") ? "fixture" : "live";

  return { site, entryPoints, pagesCrawled, score, surfaces, source };
}

export function renderDiscovery(a: DiscoveryAudit): string {
  const lines: string[] = [];
  lines.push(`# Static discovery audit (v2) — ${a.site}`);
  lines.push("");
  lines.push(
    `Crawled **${a.pagesCrawled}** page(s) from ${a.entryPoints.join(", ")} — score **${a.score}/100** (${a.source}).`,
  );
  lines.push("");
  lines.push("| surface | weight | discoverable | hop | where |");
  lines.push("|---|---|---|---|---|");
  for (const s of a.surfaces) {
    lines.push(
      `| ${s.label} | ${s.weight} | ${s.found ? "yes" : "no"} | ${s.found ? (s.hop ?? 0) : "—"} | ${
        s.found ? (s.via ?? "") : s.detail
      } |`,
    );
  }
  return lines.join("\n");
}
