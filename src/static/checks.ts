/**
 * The static-audit checklist (plan.md §4, from Cloudflare Agent Readiness + axd.md).
 *
 * Each check probes one agent-readiness surface of a site and returns pass/fail
 * plus a weight. Checks only read public URLs — no keys, no agent. They are the
 * "is the plumbing exposed?" layer that sits next to the behavioral matrix.
 */
import type { Fetcher } from "./fetcher.js";
import type { StaticCheckResult, Weight } from "./types.js";

export interface StaticCheck {
  id: string;
  label: string;
  weight: Weight;
  run(site: string, fetcher: Fetcher): Promise<StaticCheckResult>;
}

/** Resolve a path against the site root (which may include a trailing slash). */
function at(site: string, path: string): string {
  try {
    return new URL(path, site.endsWith("/") ? site : site + "/").toString();
  } catch {
    return site.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
  }
}

function pass(
  id: string,
  label: string,
  weight: Weight,
  passed: boolean,
  detail: string,
  url?: string,
): StaticCheckResult {
  return { id, label, weight, passed, detail, url };
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
      return pass(this.id, this.label, this.weight, ok, ok ? "found llms.txt" : `not found (status ${r.status})`, url);
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
      return pass(this.id, this.label, this.weight, ok, ok ? "found AGENTS.md" : `not found (status ${r.status})`, url);
    },
  },
  {
    id: "markdown-docs",
    label: "Docs negotiate markdown",
    weight: 2,
    async run(site, fetcher) {
      // A docs page that can return markdown (via .md or content negotiation) is
      // far easier for an agent to read than rendered HTML.
      const url = at(site, "llms-full.txt");
      const r = await fetcher.get(url);
      const ok = r.ok && r.body.trim().length > 0;
      return pass(
        this.id,
        this.label,
        this.weight,
        ok,
        ok ? "machine-readable docs available" : `no markdown docs surface (status ${r.status})`,
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
      for (const path of ["openapi.json", "openapi.yaml", ".well-known/openapi.json", "api/openapi.json"]) {
        const url = at(site, path);
        const r = await fetcher.get(url);
        if (r.ok && /openapi|swagger/i.test(r.body.slice(0, 4000))) {
          return pass(this.id, this.label, this.weight, true, `OpenAPI at ${path}`, url);
        }
      }
      return pass(this.id, this.label, this.weight, false, "no OpenAPI spec at conventional paths");
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
      return pass(this.id, this.label, this.weight, ok, ok ? "MCP descriptor found" : `no MCP descriptor (status ${r.status})`, url);
    },
  },
  {
    id: "official-sdk",
    label: "Official SDK referenced",
    weight: 1,
    async run(site, fetcher) {
      // A weak signal from the homepage: does it point at an SDK / developer hub?
      const r = await fetcher.get(site);
      const ok = r.ok && /(sdk|client library|npm install|pip install|developers?\.)/i.test(r.body);
      return pass(this.id, this.label, this.weight, ok, ok ? "SDK/dev references on site" : "no obvious SDK references", site);
    },
  },
  {
    id: "robots-sitemap",
    label: "robots.txt + sitemap",
    weight: 1,
    async run(site, fetcher) {
      const robotsUrl = at(site, "robots.txt");
      const robots = await fetcher.get(robotsUrl);
      const hasRobots = robots.ok && robots.body.trim().length > 0;
      const hasSitemap = hasRobots && /sitemap:/i.test(robots.body);
      const ok = hasRobots && hasSitemap;
      const detail = !hasRobots
        ? `no robots.txt (status ${robots.status})`
        : hasSitemap
          ? "robots.txt references a sitemap"
          : "robots.txt present but no sitemap reference";
      return pass(this.id, this.label, this.weight, ok, detail, robotsUrl);
    },
  },
  {
    id: "auth-discovery",
    label: "OAuth / auth discovery",
    weight: 2,
    async run(site, fetcher) {
      // A discoverable auth descriptor lets an agent figure out how to log in.
      for (const path of [".well-known/oauth-authorization-server", ".well-known/openid-configuration"]) {
        const url = at(site, path);
        const r = await fetcher.get(url);
        if (r.ok && /authorization_endpoint|token_endpoint|issuer/i.test(r.body.slice(0, 4000))) {
          return pass(this.id, this.label, this.weight, true, `auth metadata at ${path}`, url);
        }
      }
      return pass(this.id, this.label, this.weight, false, "no OAuth/OIDC discovery document");
    },
  },
];
