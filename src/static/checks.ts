/**
 * The static-audit checklist (plan.md §4, from Cloudflare Agent Readiness + axd.md).
 *
 * Each check probes one agent-readiness surface of a site and returns pass/fail
 * plus a weight. Checks only read public URLs — no keys, no agent. They are the
 * "is the plumbing exposed?" layer that sits next to the behavioral matrix.
 */
import type { FetchResult, Fetcher } from "./fetcher.js";
import type { CheckStatus, StaticCheckResult, Weight } from "./types.js";

export interface StaticCheck {
  id: string;
  label: string;
  weight: Weight;
  run(site: string, fetcher: Fetcher): Promise<StaticCheckResult>;
}

/** A fetch that never completed (status 0) means "couldn't evaluate", not
 *  "surface absent" — callers must surface that as `error`, not `fail`. */
function errored(r: FetchResult): boolean {
  return r.status === 0;
}

/** Resolve a path against the site root (which may include a trailing slash). */
function at(site: string, path: string): string {
  try {
    return new URL(path, site.endsWith("/") ? site : site + "/").toString();
  } catch {
    return site.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
  }
}

/** Build a result from a single deciding fetch: error if it never completed,
 *  otherwise pass/fail from `ok`. Carries the fetch's provenance. */
function fromFetch(
  check: StaticCheck,
  r: FetchResult,
  ok: boolean,
  passDetail: string,
  failDetail: string,
  url?: string,
): StaticCheckResult {
  if (errored(r)) {
    return result(check, "error", `could not reach ${url ?? "target"}`, r.source, url);
  }
  return result(check, ok ? "pass" : "fail", ok ? passDetail : failDetail, r.source, url);
}

function result(
  check: StaticCheck,
  status: CheckStatus,
  detail: string,
  source: "live" | "fixture",
  url?: string,
): StaticCheckResult {
  return { id: check.id, label: check.label, weight: check.weight, status, detail, source, url };
}

export const CHECKS: StaticCheck[] = [
  {
    id: "llms-txt",
    label: "llms.txt present",
    weight: 3,
    async run(site, fetcher) {
      const url = at(site, "llms.txt");
      const r = await fetcher.get(url);
      const ok = r.ok && r.body.trim().length > 0;
      return fromFetch(this, r, ok, "found llms.txt", `not found (status ${r.status})`, url);
    },
  },
  {
    id: "agents-md",
    label: "AGENTS.md present",
    weight: 2,
    async run(site, fetcher) {
      const url = at(site, "AGENTS.md");
      const r = await fetcher.get(url);
      const ok = r.ok && r.body.trim().length > 0;
      return fromFetch(this, r, ok, "found AGENTS.md", `not found (status ${r.status})`, url);
    },
  },
  {
    id: "markdown-docs",
    label: "Machine-readable docs index (llms-full.txt)",
    weight: 2,
    async run(site, fetcher) {
      // Probes for an llms-full.txt docs index — a concrete, machine-readable
      // docs surface. (Full HTTP content-negotiation, e.g. Accept: text/markdown
      // or .md variants, is a deeper signal left for a later check.)
      const url = at(site, "llms-full.txt");
      const r = await fetcher.get(url);
      const ok = r.ok && r.body.trim().length > 0;
      return fromFetch(
        this,
        r,
        ok,
        "llms-full.txt docs index available",
        `no llms-full.txt docs index (status ${r.status})`,
        url,
      );
    },
  },
  {
    id: "openapi",
    label: "OpenAPI spec discoverable",
    weight: 3,
    async run(site, fetcher) {
      // Try a few conventional locations for a machine-readable API spec.
      return probePaths(
        this,
        fetcher,
        site,
        ["openapi.json", "openapi.yaml", ".well-known/openapi.json", "api/openapi.json"],
        (r) => r.ok && /openapi|swagger/i.test(r.body.slice(0, 4000)),
        (path) => `OpenAPI at ${path}`,
        "no OpenAPI spec at conventional paths",
      );
    },
  },
  {
    id: "mcp-server",
    label: "MCP server advertised",
    weight: 2,
    async run(site, fetcher) {
      // Model Context Protocol lets agents call tools directly. Look for a
      // well-known descriptor.
      const url = at(site, ".well-known/mcp.json");
      const r = await fetcher.get(url);
      const ok = r.ok && /mcp|server|tools/i.test(r.body.slice(0, 2000));
      return fromFetch(this, r, ok, "MCP descriptor found", `no MCP descriptor (status ${r.status})`, url);
    },
  },
  {
    id: "official-sdk",
    label: "Official SDK referenced",
    weight: 1,
    async run(site, fetcher) {
      // A weak signal from the homepage: does it point at an SDK / developer hub?
      // Anchored to reduce false positives from incidental prose like "developers.".
      const r = await fetcher.get(site);
      const ok =
        r.ok &&
        /(\bsdk\b|client librar(y|ies)|npm install|pip install|developer portal|developers?\.[a-z0-9-]+\.[a-z])/i.test(
          r.body,
        );
      return fromFetch(this, r, ok, "SDK/dev references on site", "no obvious SDK references", site);
    },
  },
  {
    id: "robots-sitemap",
    label: "robots.txt + sitemap",
    weight: 1,
    async run(site, fetcher) {
      const robotsUrl = at(site, "robots.txt");
      const robots = await fetcher.get(robotsUrl);
      if (errored(robots)) {
        return result(this, "error", `could not reach ${robotsUrl}`, robots.source, robotsUrl);
      }
      const hasRobots = robots.ok && robots.body.trim().length > 0;
      const hasSitemap = hasRobots && /sitemap:/i.test(robots.body);
      const ok = hasRobots && hasSitemap;
      const detail = !hasRobots
        ? `no robots.txt (status ${robots.status})`
        : hasSitemap
          ? "robots.txt references a sitemap"
          : "robots.txt present but no sitemap reference";
      return result(this, ok ? "pass" : "fail", detail, robots.source, robotsUrl);
    },
  },
  {
    id: "auth-discovery",
    label: "OAuth / auth discovery",
    weight: 2,
    async run(site, fetcher) {
      // A discoverable auth descriptor lets an agent figure out how to log in.
      return probePaths(
        this,
        fetcher,
        site,
        [".well-known/oauth-authorization-server", ".well-known/openid-configuration"],
        (r) => r.ok && /authorization_endpoint|token_endpoint|issuer/i.test(r.body.slice(0, 4000)),
        (path) => `auth metadata at ${path}`,
        "no OAuth/OIDC discovery document",
      );
    },
  },
];

/**
 * Try several conventional paths until one matches. Distinguishes "errored"
 * (every probe failed to reach the network) from "fail" (reached, none matched):
 * a check is only `error` if *all* probes errored, so a single reachable 404
 * still counts as a genuine absence.
 */
async function probePaths(
  check: StaticCheck,
  fetcher: Fetcher,
  site: string,
  paths: string[],
  match: (r: FetchResult) => boolean,
  passDetail: (path: string) => string,
  failDetail: string,
): Promise<StaticCheckResult> {
  let allErrored = true;
  let lastSource: "live" | "fixture" = "live";
  let lastUrl = site;
  for (const path of paths) {
    const url = at(site, path);
    const r = await fetcher.get(url);
    lastSource = r.source;
    lastUrl = url;
    if (!errored(r)) allErrored = false;
    if (match(r)) {
      return result(check, "pass", passDetail(path), r.source, url);
    }
  }
  if (allErrored) {
    return result(check, "error", `could not reach any ${check.id} path`, lastSource, lastUrl);
  }
  return result(check, "fail", failDetail, lastSource);
}
