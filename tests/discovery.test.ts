import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "../src/ingest/openapi.js";
import { generatePack } from "../src/generate/pack.js";
import { scoreDiscovery, type DiscoveryResult } from "../src/generate/discovery.js";
import { buildExecutorPrompt } from "../src/harness/executor.js";
import { getProfile } from "../src/harness/profile.js";
import type { DiscoverySpec } from "../src/schemas.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "static",
  "fixtures",
  "asana.com_openapi.json",
);

function fakeClient(store: Record<string, Record<string, unknown>>) {
  return {
    async get(path: string) {
      const gid = path.split("/").pop()!;
      const body = store[gid];
      if (!body) throw new Error(`404 ${path}`);
      return body;
    },
  } as unknown as import("../src/http/client.js").BearerClient;
}

describe("discovery generation", () => {
  const spec = parseSpec(readFileSync(FIXTURE, "utf8"), "fixture");
  const pack = generatePack(spec, {
    packName: "asana-generated",
    limit: 2,
    prefer: ["tasks"],
    siteUrl: "https://developers.asana.com",
    docsUrls: ["https://developers.asana.com/docs"],
    authMethod: "pat",
    product: "Asana",
  });

  it("configures Phase 0 with official domains + canonical endpoint, no leaked outcome", () => {
    expect(pack.discovery).toBeTruthy();
    expect(pack.discovery!.product).toBe("Asana");
    expect(pack.discovery!.official_domains).toContain("developers.asana.com");
    expect(pack.discovery!.canonical_endpoint).toBe("POST /tasks");
    // Framing goal, not a single-resource probe: no endpoint and no {ns} probe.
    expect(pack.discovery!.goal).toMatch(/API/);
    expect(pack.discovery!.goal).not.toContain("{ns}");
    // Discovery is step 0; the L1-L4 tasks are the outcome, so no own round-trip.
    expect(pack.discovery!.outcome).toBeUndefined();
  });

  it("is omitted when no product is given", () => {
    const none = generatePack(spec, { packName: "x", limit: 2 });
    expect(none.discovery).toBeUndefined();
  });

  it("the executor prompt runs Phase 0 without leaking endpoint/docs", () => {
    const prompt = buildExecutorPrompt({
      pack,
      profile: getProfile("floor"),
      ns: "ns1",
      resultsPath: "results/run-floor.json",
      tracePath: "results/run-floor.trace.json",
    });
    expect(prompt).toMatch(/PHASE 0 — DISCOVERY/);
    expect(prompt).not.toContain("POST /tasks");
    expect(prompt).not.toContain("developers.asana.com");
    expect(prompt).toContain('"searches"');
    expect(prompt).toContain('"endpoint_used"');
  });
});

describe("discovery scoring", () => {
  const spec: DiscoverySpec = {
    product: "Asana",
    goal: 'create a task "AX probe discovery {ns}"',
    official_domains: ["developers.asana.com", "asana.com"],
    canonical_endpoint: "POST /tasks",
    deprecated_markers: ["app.asana.com/api/1.0/tasks.xml"],
    auth_scheme: "Bearer personal access token",
    outcome: {
      type: "roundtrip",
      description: "",
      readPathTemplate: "/tasks/{gid}",
      assertField: "name",
      expected: "AX probe discovery {ns}",
    },
  };

  it("scores a clean discovery run as all-pass", async () => {
    const result: DiscoveryResult = {
      ns: "ns1",
      completed_gid: "1",
      searches: ["asana api create task"],
      urls_visited: ["https://developers.asana.com/reference/createtask"],
      endpoint_used: "post /tasks/",
      auth_scheme_found: "Bearer personal access token",
    };
    const report = await scoreDiscovery(spec, result, fakeClient({ "1": { name: "AX probe discovery ns1" } }));
    const by = Object.fromEntries(report.metrics.map((m) => [m.id, m.passed]));
    expect(by.official).toBe(true);
    expect(by.canonical).toBe(true);
    expect(by.misled).toBe(true); // passed = not misled
    expect(by.auth).toBe(true);
    expect(by.outcome).toBe(true);
    expect(report.hops).toBe(1);
  });

  it("flags misled when the first landing is non-official", async () => {
    const result: DiscoveryResult = {
      ns: "ns1",
      completed_gid: "1",
      searches: ["asana create task", "asana task api stackoverflow", "asana rest"],
      urls_visited: ["https://stackoverflow.com/q/123", "https://developers.asana.com/reference/createtask"],
      endpoint_used: "POST /tasks",
      auth_scheme_found: "OAuth",
    };
    const report = await scoreDiscovery(spec, result, fakeClient({ "1": { name: "AX probe discovery ns1" } }));
    const by = Object.fromEntries(report.metrics.map((m) => [m.id, m.passed]));
    expect(by.misled).toBe(false); // started non-official → misled
    expect(by.auth).toBe(false); // OAuth != Bearer PAT
    expect(by.official).toBe(true); // still reached official eventually
  });

  it("fails outcome when no gid was produced", async () => {
    const result: DiscoveryResult = { ns: "ns1", completed_gid: null, searches: [], urls_visited: [] };
    const report = await scoreDiscovery(spec, result, fakeClient({}));
    expect(report.metrics.find((m) => m.id === "outcome")!.passed).toBe(false);
  });
});

describe("surface-aware discovery scoring", () => {
  const spec: DiscoverySpec = {
    product: "Linear",
    goal: "create an issue",
    official_domains: ["linear.app", "developers.linear.app"],
    canonical_endpoint: "create_issue",
    deprecated_markers: [],
    auth_scheme: "Bearer personal access token",
  };
  const client = fakeClient({});

  it("credits MCP tools/list as authoritative discovery even with a web search", async () => {
    // The agent web-searched (urls present, none official) but objectively
    // listed the server's tools — that IS discovery for a self-describing surface.
    const result: DiscoveryResult = {
      searches: ["linear mcp server"],
      urls_visited: ["https://example.com/blog/linear-mcp"],
      endpoint_used: "mcp.linear.app.create_issue",
      auth_scheme_found: "Authorization: Bearer <token>",
      inspected_local_source: true,
    };
    const report = await scoreDiscovery(spec, result, client, { surface: "mcp" });
    const by = Object.fromEntries(report.metrics.map((m) => [m.id, m.passed]));
    expect(by.official).toBe(true); // local tools/list counts
    expect(by.canonical).toBe(true); // used == canonical (create_issue)
  });

  it("on the API surface a non-official web page is NOT local discovery", async () => {
    const result: DiscoveryResult = {
      searches: ["linear api"],
      urls_visited: ["https://example.com/blog/linear"],
      endpoint_used: "create_issue",
      inspected_local_source: false,
    };
    const report = await scoreDiscovery(spec, result, client, { surface: "api" });
    expect(report.metrics.find((m) => m.id === "official")!.passed).toBe(false);
  });

  it("CLI --help with no web pages counts as local discovery (fallback path)", async () => {
    const result: DiscoveryResult = {
      searches: [],
      urls_visited: [],
      endpoint_used: "create_issue",
      inspected_local_source: false, // even without the explicit flag, no-web + used works
    };
    const report = await scoreDiscovery(spec, result, client, { surface: "cli" });
    expect(report.metrics.find((m) => m.id === "official")!.passed).toBe(true);
  });

  it("MCP auth PASSES when a tool was used, even though the found scheme (OAuth) != the API's Bearer-PAT", async () => {
    // The pack's auth_scheme is the REST API's "Bearer PAT"; the MCP surface uses
    // OAuth, handled by the transport. Grading the found OAuth against Bearer-PAT
    // would be a false FAIL — success is implied by having used the surface.
    const result: DiscoveryResult = {
      searches: [],
      urls_visited: [],
      endpoint_used: "mcp.linear.app.create_issue",
      auth_scheme_found: "OAuth via the hosted MCP server",
      inspected_local_source: true,
    };
    const report = await scoreDiscovery(spec, result, client, { surface: "mcp" });
    expect(report.metrics.find((m) => m.id === "auth")!.passed).toBe(true);
  });

  it("local artifact paths are not treated as misleading web landings", async () => {
    const result: DiscoveryResult = {
      searches: [],
      urls_visited: ["targets/exa/pack.yaml"],
      endpoint_used: "web_search_exa",
      auth_scheme_found: "EXA_API_KEY environment variable",
      inspected_local_source: true,
    };
    const report = await scoreDiscovery(spec, result, client, { surface: "mcp" });
    expect(report.metrics.find((m) => m.id === "misled")!.passed).toBe(true);
    expect(report.metrics.find((m) => m.id === "canonical")!.passed).toBe(true);
    expect(report.metrics.find((m) => m.id === "auth")!.passed).toBe(true);
  });

  it("MCP auth FAILS only when no tool was used (couldn't authenticate at all)", async () => {
    const result: DiscoveryResult = {
      searches: ["linear mcp"],
      urls_visited: [],
      endpoint_used: "",
      auth_scheme_found: "",
      inspected_local_source: false,
    };
    const report = await scoreDiscovery(spec, result, client, { surface: "mcp" });
    expect(report.metrics.find((m) => m.id === "auth")!.passed).toBe(false);
  });

  it("API surface still grades auth strictly (OAuth != Bearer-PAT is a real FAIL)", async () => {
    const result: DiscoveryResult = {
      searches: [],
      urls_visited: ["https://developers.linear.app"],
      endpoint_used: "create_issue",
      auth_scheme_found: "OAuth",
    };
    const report = await scoreDiscovery(spec, result, client, { surface: "api" });
    expect(report.metrics.find((m) => m.id === "auth")!.passed).toBe(false);
  });
});

describe("graphql canonical scoring (single endpoint → match by mutation name)", () => {
  const spec: DiscoverySpec = {
    product: "Monday.com",
    goal: "create an item",
    official_domains: ["monday.com", "developer.monday.com"],
    canonical_endpoint: "mutation create_item",
    deprecated_markers: [],
    auth_scheme: "API token in the raw Authorization header (no Bearer prefix) + API-Version header",
  };
  const client = fakeClient({});

  it("passes canonical when the agent reports the endpoint as POST <single endpoint> (mutation create_item)", async () => {
    const result: DiscoveryResult = {
      searches: ["monday api create_item graphql"],
      urls_visited: ["https://developer.monday.com/api-reference/docs/getting-started"],
      endpoint_used: "POST https://api.monday.com/v2 (mutation create_item)",
      auth_scheme_found: "API token in the raw Authorization header (no Bearer prefix)",
    };
    const report = await scoreDiscovery(spec, result, client, { surface: "api", apiStyle: "graphql" });
    const by = Object.fromEntries(report.metrics.map((m) => [m.id, m.passed]));
    // The METHOD+path string can never equal "MUTATION create_item"; matching by
    // operation name is what makes this fair for a single-endpoint GraphQL API.
    expect(by.canonical).toBe(true);
    expect(by.official).toBe(true);
  });

  it("still fails canonical for graphql when the mutation name is absent", async () => {
    const result: DiscoveryResult = {
      searches: ["monday api graphql"],
      urls_visited: ["https://developer.monday.com/api-reference/docs"],
      endpoint_used: "POST https://api.monday.com/v2",
      auth_scheme_found: "Authorization header",
    };
    const report = await scoreDiscovery(spec, result, client, { surface: "api", apiStyle: "graphql" });
    expect(report.metrics.find((m) => m.id === "canonical")!.passed).toBe(false);
  });

  it("REST canonical is unchanged (strict METHOD+path)", async () => {
    const restSpec: DiscoverySpec = { ...spec, canonical_endpoint: "POST /tasks" };
    const result: DiscoveryResult = {
      searches: ["asana api"],
      urls_visited: ["https://developer.monday.com/x"],
      endpoint_used: "POST https://api.monday.com/v2 (create_item)",
      auth_scheme_found: "Bearer token",
    };
    const report = await scoreDiscovery(restSpec, result, client, { surface: "api", apiStyle: "rest" });
    // "POST https://api.monday.com/v2" !== "POST /tasks" → strict REST match fails.
    expect(report.metrics.find((m) => m.id === "canonical")!.passed).toBe(false);
  });
});
