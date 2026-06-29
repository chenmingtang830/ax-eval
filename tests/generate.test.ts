import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "../src/ingest/openapi.js";
import { generatePack, GENERATED_BY, packToYaml } from "../src/generate/pack.js";
import { TargetPackSchema } from "../src/schemas.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "static",
  "fixtures",
  "asana.com_openapi.json",
);

describe("deterministic generation", () => {
  const spec = parseSpec(readFileSync(FIXTURE, "utf8"), "fixture");
  const pack = generatePack(spec, {
    packName: "test",
    limit: 2,
    prefer: ["tasks", "projects", "sections"],
  });

  it("stamps generation provenance, not an execution score", () => {
    expect(pack.generated_by).toBe(GENERATED_BY);
    expect(pack.standard_set_version).toMatch(/^gen-/);
    expect(pack.request_envelope).toBe("data");
  });

  it("produces an L1/L2/L3 ladder", () => {
    const diffs = pack.tasks.map((t) => t.difficulty);
    expect(diffs).toContain("L1");
    expect(diffs).toContain("L2");
    expect(diffs).toContain("L3");
  });

  it("L3 is an ambiguous, natural-language goal (comprehension, not docs-only)", () => {
    const l3 = pack.tasks.find((t) => t.difficulty === "L3")!;
    // No longer a surface restriction — discovery is shared Phase 0 now.
    expect(l3.allowed_surfaces).toEqual(["api", "docs"]);
    // Ambiguous phrasing (a to-do list), not a literal "create a <resource>".
    expect(l3.prompt).toMatch(/to-do list/);
  });

  it("can emit multiple L3 tasks when requested", () => {
    const richSpec = parseSpec(JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Work API" },
      servers: [{ url: "https://api.work.test/v1" }],
      paths: {
        "/tasks": { post: { operationId: "create_task", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
        "/tasks/{task_id}": { get: { operationId: "get_task" }, patch: { operationId: "update_task" } },
        "/projects": { post: { operationId: "create_project", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
        "/projects/{project_id}": { get: { operationId: "get_project" }, patch: { operationId: "update_project" } },
        "/goals": { post: { operationId: "create_goal", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
        "/goals/{goal_id}": { get: { operationId: "get_goal" } },
      },
    }), "work");
    const expanded = generatePack(richSpec, {
      packName: "test",
      limit: 2,
      l3Limit: 3,
      prefer: ["tasks", "projects", "goals"],
    });
    expect(expanded.tasks.filter((t) => t.difficulty === "L3")).toHaveLength(3);
  });

  it("task prompts never inject the endpoint (goal-level only)", () => {
    for (const t of pack.tasks) {
      expect(t.prompt, t.id).not.toMatch(/POST \//);
      expect(t.prompt, t.id).not.toMatch(/GET \//);
    }
  });

  it("L2 chains a child under a parent it can create", () => {
    const l2 = pack.tasks.find((t) => t.difficulty === "L2")!;
    expect(l2.depends_on.length).toBeGreaterThan(0);
    expect(l2.create_path).toContain("{");
  });

  it("each task carries a programmatic round-trip oracle", () => {
    for (const t of pack.tasks) {
      const rt = t.oracles.find((o) => o.type === "roundtrip");
      expect(rt, t.id).toBeTruthy();
      expect(rt!.readPathTemplate).toContain("{gid}");
      expect(rt!.assertField).toBeTruthy();
      expect(rt!.expected).toBeTruthy();
    }
  });

  it("is deterministic (same input → same task ids)", () => {
    const again = generatePack(spec, { packName: "test", limit: 2, prefer: ["tasks", "projects", "sections"] });
    expect(again.tasks.map((t) => t.id)).toEqual(pack.tasks.map((t) => t.id));
  });

  it("gives each generation a unique run_id (version tag, not in names)", () => {
    const a = generatePack(spec, { packName: "test", limit: 2 });
    const b = generatePack(spec, { packName: "test", limit: 2 });
    expect(a.run_id).not.toEqual(b.run_id);
  });

  it("bakes a {ns} placeholder into names, not a hardcoded id", () => {
    const name = pack.tasks[0]!.oracles[0]!.expected as string;
    expect(name).toContain("{ns}");
    expect(name).not.toContain(pack.run_id);
  });

  it("honors an explicit runId for reproducibility (version tag only)", () => {
    const fixed = generatePack(spec, { packName: "test", limit: 2, runId: "2026-06-02-abc123" });
    expect(fixed.run_id).toBe("2026-06-02-abc123");
    expect(fixed.tasks[0]!.oracles[0]!.expected).toContain("{ns}");
  });

  it("full-pack backfill prefers harder tiers before widening L1 breadth", () => {
    const richSpec = parseSpec(JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Work API" },
      servers: [{ url: "https://api.work.test/v1" }],
      paths: {
        "/tasks": { post: { operationId: "create_task", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
        "/tasks/{task_id}": { get: { operationId: "get_task" }, patch: { operationId: "update_task" } },
        "/projects": { post: { operationId: "create_project", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
        "/projects/{project_id}": { get: { operationId: "get_project" }, patch: { operationId: "update_project" } },
        "/goals": { post: { operationId: "create_goal", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
        "/goals/{goal_id}": { get: { operationId: "get_goal" }, patch: { operationId: "update_goal" } },
        "/portfolios": { post: { operationId: "create_portfolio", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
        "/portfolios/{portfolio_id}": { get: { operationId: "get_portfolio" }, patch: { operationId: "update_portfolio" } },
      },
    }), "work");
    const full = generatePack(richSpec, {
      packName: "test",
      limit: 3,
      l2Limit: 0,
      l3Limit: 3,
      l4Limit: 3,
      targetTaskCount: 10,
      prefer: ["tasks", "projects", "goals", "portfolios"],
    });
    expect(full.tasks).toHaveLength(10);
    expect(full.tasks.filter((t) => t.difficulty === "L3")).toHaveLength(3);
    expect(full.tasks.filter((t) => t.difficulty === "L4").length).toBeGreaterThanOrEqual(3);
  });

  it("serializes to a re-loadable frozen pack", () => {
    const yaml = packToYaml(pack);
    expect(yaml).toContain("GENERATED");
    expect(() => TargetPackSchema.parse(pack)).not.toThrow();
  });

  it("emits a structurally-runnable auth + headers + sandbox_scope scaffold", () => {
    // The fixture declares no securitySchemes; with an `authMethod` hint the
    // generator still derives a usable auth block + a product-named env var.
    const p = generatePack(spec, {
      packName: "demo",
      product: "Demo",
      authMethod: "pat",
      limit: 2,
      prefer: ["tasks", "projects", "sections"],
    });
    expect(p.auth).toBeTruthy();
    expect(p.auth!.type).toBe("bearer");
    expect(p.auth!.env).toBe("DEMO_TOKEN");
    // Headers default to an explicit empty map (none derivable here).
    expect(p.headers).toEqual({});
    // One scope entry for the container the L2 chain creates under (projects).
    expect(p.sandbox_scope).toHaveLength(1);
    expect(p.sandbox_scope[0]!.name).toBe("project_id");
    expect(p.sandbox_scope[0]!.env).toBe("DEMO_SANDBOX_PROJECT_ID");
    expect(p.sandbox_scope[0]!.required).toBe(true);
    expect(p.sandbox_scope[0]!.instructions).toMatch(/throwaway/i);
    // The whole thing must still pass schema validation.
    expect(() => TargetPackSchema.parse(p)).not.toThrow();
  });

  it("derives an api-key env var + header from an ingested apiKey scheme", () => {
    const apiKeySpec = {
      ...spec,
      auth: { type: "api-key" as const, header: "X-Linear-Key" },
      constantHeaders: { "Linear-Version": "2026" },
    };
    const p = generatePack(apiKeySpec, { packName: "linear", product: "Linear", limit: 1 });
    expect(p.auth!.type).toBe("api-key");
    expect(p.auth!.env).toBe("LINEAR_API_KEY");
    expect(p.auth!.header).toBe("X-Linear-Key");
    expect(p.headers).toEqual({ "Linear-Version": "2026" });
  });

  it("passes through declared non-api surfaces onto the generated REST pack", () => {
    const withSurfaces = generatePack(spec, {
      packName: "test",
      limit: 2,
      surfaces: {
        cli: { bin: "demo", docs_url: "https://example.test/cli" },
        sdk: { package: "@demo/sdk", language: "node" },
        mcp: { server: "https://example.test/mcp", transport: "http" },
      },
    });
    expect(withSurfaces.surfaces).toEqual({
      cli: { bin: "demo", docs_url: "https://example.test/cli" },
      sdk: { package: "@demo/sdk", language: "node" },
      mcp: { server: "https://example.test/mcp", transport: "http" },
    });
    expect(withSurfaces.tasks.every((task) => task.allowed_surfaces.includes("docs"))).toBe(true);
    expect(withSurfaces.tasks.every((task) => task.allowed_surfaces.includes("api"))).toBe(true);
    expect(withSurfaces.tasks.every((task) => task.allowed_surfaces.includes("cli"))).toBe(true);
    expect(withSurfaces.tasks.every((task) => task.allowed_surfaces.includes("sdk"))).toBe(true);
    expect(withSurfaces.tasks.every((task) => task.allowed_surfaces.includes("mcp"))).toBe(true);
  });

  it("filters per-surface task coverage from generation-time policies", () => {
    const codaLike = parseSpec(JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Docs API" },
      servers: [{ url: "https://api.docs.test/v1" }],
      paths: {
        "/docs": { post: { operationId: "create_doc", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } }, get: { operationId: "list_docs" } },
        "/docs/{doc_id}": { get: { operationId: "get_doc" }, patch: { operationId: "update_doc" } },
        "/folders": { post: { operationId: "create_folder", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
        "/folders/{folder_id}": { get: { operationId: "get_folder" }, patch: { operationId: "update_folder" } },
        "/packs": { post: { operationId: "create_pack", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
        "/packs/{pack_id}": { get: { operationId: "get_pack" }, patch: { operationId: "update_pack" } },
        "/docs/{doc_id}/pages": { post: { operationId: "create_page", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
        "/docs/{doc_id}/pages/{page_id}": { get: { operationId: "get_page" } },
        "/docs/{doc_id}/tables/{table_id}/rows": { post: { operationId: "create_row", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
        "/docs/{doc_id}/tables/{table_id}/rows/{row_id}": { get: { operationId: "get_row" } },
        "/docs/{doc_id}/pages/{page_id}/export": { post: { operationId: "create_export", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
        "/docs/{doc_id}/pages/{page_id}/export/{export_id}": { get: { operationId: "get_export" } },
      },
    }), "docs");

    const pack = generatePack(codaLike, {
      packName: "docs-generated",
      limit: 3,
      l2Limit: 3,
      l3Limit: 3,
      l4Limit: 3,
      targetTaskCount: 12,
      prefer: ["docs", "folders", "packs"],
      surfaces: {
        mcp: { server: "https://example.test/mcp", transport: "http" },
      },
      surfaceTaskPolicies: {
        api: {
          simpleResources: ["docs", "folders", "packs"],
          nestedResources: ["docs", "pages"],
          goalResources: [],
          lifecycleResources: ["docs", "folders", "packs"],
        },
        mcp: {
          simpleResources: ["docs"],
          nestedResources: ["docs", "pages", "rows"],
          goalResources: [],
          lifecycleResources: [],
        },
      },
    });

    expect(pack.tasks.find((task) => task.id === "gen-l1-docs")!.allowed_surfaces).toContain("mcp");
    expect(pack.tasks.find((task) => task.id === "gen-l1-folders")!.allowed_surfaces).not.toContain("mcp");
    expect(pack.tasks.find((task) => task.id === "gen-l2-docs-rows")!.allowed_surfaces).not.toContain("api");
    expect(pack.tasks.find((task) => task.id === "gen-l2-docs-pages")!.allowed_surfaces).toContain("mcp");
    expect(pack.tasks.find((task) => task.id === "gen-l2-docs-rows")!.allowed_surfaces).toContain("mcp");
    expect(pack.tasks.find((task) => task.id === "gen-l2-docs-export")).toBeUndefined();
    expect(pack.tasks.find((task) => task.id === "gen-l3-docs-1")!.allowed_surfaces).not.toContain("api");
    expect(pack.tasks.find((task) => task.id === "gen-l3-docs-1")!.allowed_surfaces).not.toContain("mcp");
    expect(pack.tasks.find((task) => task.id === "gen-l3-folders-2")!.allowed_surfaces).not.toContain("mcp");
    expect(pack.tasks.find((task) => task.id === "gen-l4-docs-lifecycle")!.allowed_surfaces).not.toContain("mcp");
  });

  it("appends fully-authored curated tasks and records curated provenance", () => {
    const curated = generatePack(spec, {
      packName: "test",
      limit: 1,
      l2Limit: 0,
      l3Limit: 0,
      l4Limit: 0,
      curatedTasks: [
        {
          id: "custom-page",
          title: "L4: custom page flow",
          difficulty: "L4",
          prompt: 'Create a page "AX probe custom {ns}". Report gid and docId.',
          allowed_surfaces: ["docs", "mcp"],
          create_path: "/docs/{docId}/pages",
          depends_on: [],
          trace: [],
          oracles: [
            {
              type: "roundtrip",
              readPathTemplate: "/docs/{docId}/pages/{gid}",
              assertField: "name",
              expected: "AX probe custom {ns}",
            },
          ],
        },
      ],
    });

    const task = curated.tasks.find((t) => t.id === "custom-page");
    expect(task).toBeTruthy();
    expect(task!.allowed_surfaces).toEqual(["docs", "mcp"]);
    expect(curated.generated_by).toContain("task-curated");
  });

  it("can exclude resource families from generic deterministic generation", () => {
    const codaLike = parseSpec(JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Docs API" },
      servers: [{ url: "https://api.docs.test/v1" }],
      paths: {
        "/docs": { post: { operationId: "create_doc", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
        "/docs/{doc_id}": { get: { operationId: "get_doc" }, patch: { operationId: "update_doc" } },
        "/docs/{doc_id}/tables/{table_id}/rows": { post: { operationId: "create_row", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
        "/docs/{doc_id}/tables/{table_id}/rows/{row_id}": { get: { operationId: "get_row" } },
      },
    }), "docs");

    const pack = generatePack(codaLike, {
      packName: "docs-generated",
      limit: 2,
      l2Limit: 2,
      l3Limit: 1,
      l4Limit: 1,
      excludeResources: ["rows"],
    });

    expect(pack.tasks.find((task) => task.id === "gen-l2-docs-rows")).toBeUndefined();
  });
});

describe("L4 curated generation", () => {
  const spec = parseSpec(readFileSync(FIXTURE, "utf8"), "fixture");
  const pack = generatePack(spec, {
    packName: "test",
    limit: 2,
    prefer: ["tasks", "projects"],
    l4: [
      {
        idSuffix: "task-complete",
        title: "L4: complete a task",
        resource: "tasks",
        prompt: `Create a task named "{val}", then complete it.`,
        assertField: "completed",
        expected: true,
      },
    ],
  });

  it("appends an L4 task with a non-identity, mutated-field oracle", () => {
    const l4 = pack.tasks.find((t) => t.difficulty === "L4");
    expect(l4, "L4 task present").toBeTruthy();
    expect(l4!.id).toBe("gen-l4-task-complete");
    const rt = l4!.oracles.find((o) => o.type === "roundtrip")!;
    expect(rt.assertField).toBe("completed");
    expect(rt.expected).toBe(true);
    expect(rt.readPathTemplate).toContain("{gid}");
  });

  it("substitutes the {val} probe name and stays goal-level (no endpoint)", () => {
    const l4 = pack.tasks.find((t) => t.difficulty === "L4")!;
    expect(l4.prompt).not.toContain("{val}");
    expect(l4.prompt).not.toMatch(/POST \//);
    expect(l4.prompt).toMatch(/AX probe tasks-task-complete/);
  });

  it("marks provenance as curated when L4 templates are used", () => {
    expect(pack.generated_by).toContain("l4-curated");
  });

  it("skips an L4 template whose resource is absent from the spec", () => {
    const none = generatePack(spec, {
      packName: "test",
      limit: 2,
      l4: [
        {
          idSuffix: "ghost",
          title: "nope",
          resource: "this_resource_does_not_exist",
          prompt: "x {val}",
          assertField: "completed",
          expected: true,
        },
      ],
    });
    expect(none.tasks.some((t) => t.difficulty === "L4")).toBe(false);
    expect(none.generated_by).not.toContain("l4-curated");
  });
});

describe("L4 generic lifecycle generation (spec-derived)", () => {
  // A minimal spec whose item path exposes PATCH/DELETE → the full create→update
  // lifecycle is derivable without any authoring.
  const updatableSpec = JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Widget API" },
    servers: [{ url: "https://api.widget.test/v1" }],
    paths: {
      "/widgets": {
        post: {
          operationId: "create_widget",
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
              },
            },
          },
        },
      },
      "/widgets/{widget_id}": {
        get: { operationId: "get_widget" },
        patch: { operationId: "update_widget" },
        delete: { operationId: "delete_widget" },
      },
      // A read-only resource (no PATCH/PUT) → must NOT get a lifecycle task.
      "/logs": {
        post: {
          operationId: "create_log",
          requestBody: {
            content: {
              "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } },
            },
          },
        },
      },
      "/logs/{log_id}": { get: { operationId: "get_log" } },
    },
  });
  const spec = parseSpec(updatableSpec, "widget");

  it("ingest flags update/delete capability from item-path methods", () => {
    const widgets = spec.resources.find((r) => r.name === "widgets")!;
    expect(widgets.canUpdate).toBe(true);
    expect(widgets.canDelete).toBe(true);
    const logs = spec.resources.find((r) => r.name === "logs")!;
    expect(logs.canUpdate).toBe(false);
  });

  it("emits a create→rename→read-back task whose oracle asserts the NEW value", () => {
    const pack = generatePack(spec, { packName: "widget" });
    const life = pack.tasks.find((t) => t.id === "gen-l4-widgets-lifecycle");
    expect(life, "lifecycle task present").toBeTruthy();
    expect(life!.difficulty).toBe("L4");
    const rt = life!.oracles.find((o) => o.type === "roundtrip")!;
    expect(rt.assertField).toBe("name");
    expect(rt.expected).toBe("AX probe widgets-renamed {ns}");
    expect(rt.readPathTemplate).toContain("{gid}");
    // Goal-level: names the before+after values, never the endpoint.
    expect(life!.prompt).toMatch(/AX probe widgets-pre/);
    expect(life!.prompt).toMatch(/AX probe widgets-renamed/);
    expect(life!.prompt).not.toMatch(/PATCH|PUT|\/widgets/);
    // Spec-derived, so it does NOT flip the curated provenance tag.
    expect(pack.generated_by).not.toContain("l4-curated");
  });

  it("skips read-only resources and respects l4Limit=0", () => {
    const pack = generatePack(spec, { packName: "widget" });
    expect(pack.tasks.some((t) => t.id === "gen-l4-logs-lifecycle")).toBe(false);
    const off = generatePack(spec, { packName: "widget", l4Limit: 0 });
    expect(off.tasks.some((t) => t.difficulty === "L4")).toBe(false);
  });

  it("does not duplicate a resource already covered by a curated L4", () => {
    const pack = generatePack(spec, {
      packName: "widget",
      l4: [
        {
          idSuffix: "widget-archive",
          title: "L4: archive a widget",
          resource: "widgets",
          prompt: `Create a widget named "{val}", then archive it.`,
          assertField: "state",
          expected: "archived",
        },
      ],
    });
    // Curated archive present; generic rename for the same resource suppressed.
    expect(pack.tasks.some((t) => t.id === "gen-l4-widget-archive")).toBe(true);
    expect(pack.tasks.some((t) => t.id === "gen-l4-widgets-lifecycle")).toBe(false);
  });
});

describe("operation-task generation", () => {
  const spec = parseSpec(JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Search API" },
    servers: [{ url: "https://api.search.test" }],
    paths: {
      "/search": {
        post: {
          operationId: "search",
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
              },
            },
          },
        },
      },
      "/contents": {
        post: {
          operationId: "contents",
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object", properties: { urls: { type: "array", items: { type: "string" } } } },
              },
            },
          },
        },
      },
    },
  }), "search");

  it("emits stateless POST read-back tasks for search/content APIs", () => {
    const pack = generatePack(spec, {
      packName: "search",
      product: "Search",
      limit: 0,
      sandboxScope: [],
      discoveryCanonicalEndpoint: "POST /search",
      operationTasks: [
        {
          id: "search-l1-doc",
          title: "L1: find a doc",
          difficulty: "L1",
          prompt: "Use Search to find a stable doc. Report https://example.com/doc as the id.",
          expectedUrl: "https://example.com/doc",
        },
      ],
    });
    expect(pack.tasks).toHaveLength(1);
    expect(pack.sandbox_scope).toEqual([]);
    expect(pack.discovery!.canonical_endpoint).toBe("POST /search");
    expect(pack.generated_by).toContain("operation-curated");
    const oracle = pack.tasks[0]!.oracles[0]!;
    expect(oracle.readMethod).toBe("POST");
    expect(oracle.readPathTemplate).toBe("/contents");
    expect(oracle.readBodyTemplate).toEqual({ urls: ["{gid}"], text: false });
    expect(oracle.expected).toBe("https://example.com/doc");
  });
});
