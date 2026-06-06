import { describe, expect, it } from "vitest";
import { discoverSurfaces } from "../src/static/discover.js";
import type { FetchResult } from "../src/static/fetcher.js";

/** In-memory site: a map of URL -> body. Anything missing 404s. */
function fakeFetcher(pages: Record<string, string>) {
  return {
    async get(url: string): Promise<FetchResult> {
      const body = pages[url];
      if (body === undefined) return { status: 404, ok: false, body: "", headers: {}, source: "fixture" };
      return { status: 200, ok: true, body, headers: {}, source: "fixture" };
    },
  };
}

describe("static discovery (v2 crawl)", () => {
  it("finds surfaces reachable only by following links from the entry, with hops", async () => {
    const site = "https://example.test/";
    const pages = {
      // Entry: marketing root, no surfaces here — only a link to the dev hub.
      "https://example.test/": `<html><a href="/developers">Developers</a></html>`,
      // Hop 1: the docs hub links out to all the machine-readable surfaces.
      "https://example.test/developers": `
        <a href="/openapi.json">API spec</a>
        <a href="/llms.txt">llms.txt</a>
        <a href="/.well-known/mcp.json">MCP</a>
        Authenticate with OAuth 2.0 / Bearer token. Install via npm install example-sdk.
      `,
      // Hop 2: the linked artifacts themselves.
      "https://example.test/openapi.json": `{"openapi":"3.0.0","info":{}}`,
      "https://example.test/llms.txt": `# example docs index`,
      "https://example.test/.well-known/mcp.json": `{"mcpVersion":"1","tools":[]}`,
    };

    const a = await discoverSurfaces(site, { fetcher: fakeFetcher(pages) });
    const by = Object.fromEntries(a.surfaces.map((s) => [s.id, s]));

    expect(by["openapi"].found).toBe(true);
    expect(by["openapi"].hop).toBe(2); // root -> developers -> openapi.json
    expect(by["llms-txt"].found).toBe(true);
    expect(by["mcp-server"].found).toBe(true);
    expect(by["auth-discovery"].found).toBe(true); // OAuth/Bearer on the hub (hop 1)
    expect(by["auth-discovery"].hop).toBe(1);
    expect(by["official-sdk"].found).toBe(true);
    expect(by["agents-md"].found).toBe(false); // never linked
    expect(a.score).toBeGreaterThan(0);
  });

  it("does NOT credit a surface that exists but is unreachable from the entry", async () => {
    const site = "https://example.test/";
    const pages = {
      // Root links nowhere; the spec exists at a conventional path v0 would catch,
      // but no link leads to it — so an agent crawling wouldn't find it.
      "https://example.test/": `<html>nothing here</html>`,
      "https://example.test/openapi.json": `{"openapi":"3.0.0"}`,
    };
    const a = await discoverSurfaces(site, { fetcher: fakeFetcher(pages) });
    const openapi = a.surfaces.find((s) => s.id === "openapi")!;
    expect(openapi.found).toBe(false);
    expect(a.pagesCrawled).toBe(1);
  });

  it("respects maxDepth (stops expanding regular links past the limit)", async () => {
    const site = "https://example.test/";
    const pages = {
      "https://example.test/": `<a href="/a">a</a>`,
      "https://example.test/a": `<a href="/b">b</a>`,
      "https://example.test/b": `<a href="/llms.txt">deep</a>`,
      "https://example.test/llms.txt": `deep docs`,
    };
    // depth 1: crawl root(0) -> a(1); /a's link /b is hop 2 > maxDepth, not expanded.
    const a = await discoverSurfaces(site, { fetcher: fakeFetcher(pages), maxDepth: 1 });
    expect(a.surfaces.find((s) => s.id === "llms-txt")!.found).toBe(false);
  });
});
