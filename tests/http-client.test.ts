import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BearerClient } from "../src/http/client.js";

/** Capture the headers the client sends without hitting the network. */
function stubFetch(body: unknown) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = vi.fn(async (url: URL, init: RequestInit) => {
    calls.push({ url: url.toString(), headers: init.headers as Record<string, string> });
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

describe("BearerClient auth schemes + headers", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("bearer scheme prefixes the token with 'Bearer '", async () => {
    const calls = stubFetch({ name: "x" });
    const c = new BearerClient({ baseUrl: "https://api.test", token: "tok", authScheme: "bearer" });
    await c.get("/v1/thing/1");
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
  });

  it("api-key scheme sends the raw token (no 'Bearer ' — Linear/Monday)", async () => {
    const calls = stubFetch({ name: "x" });
    const c = new BearerClient({ baseUrl: "https://api.test", token: "lin_api_x", authScheme: "api-key" });
    await c.get("/graphql");
    expect(calls[0].headers.Authorization).toBe("lin_api_x");
  });

  it("sends pack-declared constant headers (e.g. Notion-Version)", async () => {
    const calls = stubFetch({ in_trash: true });
    const c = new BearerClient({
      baseUrl: "https://api.notion.com",
      token: "secret",
      extraHeaders: { "Notion-Version": "2026-03-11" },
    });
    await c.get("/v1/pages/abc");
    expect(calls[0].headers["Notion-Version"]).toBe("2026-03-11");
    expect(calls[0].headers.Authorization).toBe("Bearer secret");
  });

  it("honors a custom auth header name", async () => {
    const calls = stubFetch({ ok: 1 });
    const c = new BearerClient({ baseUrl: "https://api.test", token: "k", authScheme: "api-key", authHeader: "X-Api-Key" });
    await c.get("/x");
    expect(calls[0].headers["X-Api-Key"]).toBe("k");
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it("refuses redirects for authenticated requests", async () => {
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    });
    vi.stubGlobal("fetch", fetch);
    const c = new BearerClient({ baseUrl: "https://api.test", token: "secret", authScheme: "bearer" });
    await c.get("/x");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("unwraps the response envelope when configured", async () => {
    stubFetch({ data: { name: "wrapped" } });
    const c = new BearerClient({ baseUrl: "https://api.test", token: "t", responseEnvelope: "data" });
    const out = await c.get<{ name: string }>("/x");
    expect(out.name).toBe("wrapped");
  });
});

/** Capture method + body too, with a configurable response (for GraphQL). */
function stubGraphql(resp: { ok?: boolean; status?: number; body: unknown }) {
  const calls: { url: string; method?: string; headers: Record<string, string>; body?: unknown }[] = [];
  const fn = vi.fn(async (url: URL, init: RequestInit) => {
    calls.push({
      url: url.toString(),
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    return { ok: resp.ok ?? true, status: resp.status ?? 200, json: async () => resp.body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

describe("BearerClient.graphql (single-endpoint read path)", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the query+variables to baseUrl with raw api-key auth and returns data", async () => {
    const calls = stubGraphql({ body: { data: { issue: { title: "AX probe 7" } } } });
    const c = new BearerClient({ baseUrl: "https://api.linear.app/graphql", token: "lin_x", authScheme: "api-key" });
    const out = await c.graphql<{ issue: { title: string } }>('{ issue(id: "i1") { title } }', { id: "i1" });

    expect(calls[0].url).toBe("https://api.linear.app/graphql");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toBe("lin_x"); // raw, no "Bearer "
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].body).toEqual({ query: '{ issue(id: "i1") { title } }', variables: { id: "i1" } });
    expect(out.issue.title).toBe("AX probe 7");
  });

  it("throws on a non-empty GraphQL errors array even when HTTP is 200", async () => {
    stubGraphql({ ok: true, status: 200, body: { errors: [{ message: "Entity not found: Issue" }] } });
    const c = new BearerClient({ baseUrl: "https://api.linear.app/graphql", token: "lin_x", authScheme: "api-key" });
    await expect(c.graphql("{ issue(id: \"missing\") { title } }")).rejects.toThrow(/Entity not found/);
  });
});
