import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { TargetPackSchema, type TargetPack } from "../src/schemas.js";
import { authorPackWithLlm, buildGeneratorPrompt, validateGeneratedPack } from "../src/generate/authoring.js";

function samplePack(): TargetPack {
  return TargetPackSchema.parse({
    name: "sample-generated",
    standard_set_version: "test",
    run_id: "run-test",
    base_url: "https://api.example.test",
    site_url: "https://docs.example.test",
    docs_urls: ["https://docs.example.test/api"],
    auth_method: "api-key",
    auth: { type: "api-key", env: "EXAMPLE_API_KEY", header: "x-api-key" },
    sandbox_scope: [],
    discovery: { product: "Example", canonical_endpoint: "POST /items" },
    surfaces: {
      mcp: {
        server: "https://mcp.example.test",
        transport: "http",
        auth: { kind: "token", token_env: "EXAMPLE_MCP_TOKEN" },
      },
    },
    tasks: [
      {
        id: "l1",
        title: "L1",
        difficulty: "L1",
        prompt: "Create an item.",
        allowed_surfaces: ["api", "mcp"],
        create_path: "/items",
        oracles: [{ type: "roundtrip", readPathTemplate: "/items/{gid}", assertField: "name", expected: "one" }],
      },
      {
        id: "l2",
        title: "L2",
        difficulty: "L2",
        prompt: "Create a parent and child.",
        allowed_surfaces: ["api", "mcp"],
        create_path: "/items",
        oracles: [{ type: "roundtrip", readPathTemplate: "/items/{gid}", assertField: "name", expected: "two" }],
      },
      {
        id: "l3",
        title: "L3",
        difficulty: "L3",
        prompt: "Create the right thing for the goal.",
        allowed_surfaces: ["api", "mcp"],
        create_path: "/items",
        oracles: [{ type: "roundtrip", readPathTemplate: "/items/{gid}", assertField: "name", expected: "three" }],
      },
      {
        id: "l4",
        title: "L4",
        difficulty: "L4",
        prompt: "Create then rename an item.",
        allowed_surfaces: ["api", "mcp"],
        create_path: "/items",
        oracles: [{ type: "roundtrip", readPathTemplate: "/items/{gid}", assertField: "name", expected: "four" }],
      },
    ],
  });
}

describe("authoring prompt + validation", () => {
  it("includes preset guidance and seed surface coverage in the prompt", () => {
    const prompt = buildGeneratorPrompt(
      "Example",
      { source: "https://docs.example.test/openapi.json", resources: [{ name: "items" }] },
      samplePack(),
      ["Preserve the MCP-specific lifecycle tasks."],
    );

    expect(prompt).toContain("Generation model:");
    expect(prompt).toContain("Minimum per-surface coverage to preserve from the seed:");
    expect(prompt).toContain("- api: 4");
    expect(prompt).toContain("- mcp: 4");
    expect(prompt).toContain("Preset guidance:");
    expect(prompt).toContain("Preserve the MCP-specific lifecycle tasks.");
  });

  it("flags metadata drift and surface coverage regressions", () => {
    const seed = samplePack();
    const candidate = TargetPackSchema.parse({
      ...seed,
      auth: { type: "api-key", env: "OTHER_API_KEY", header: "x-api-key" },
      tasks: seed.tasks
        .filter((task) => task.id !== "l4")
        .map((task) => ({ ...task, allowed_surfaces: ["api"] })),
    });

    const validation = validateGeneratedPack(seed, candidate);
    expect(validation.errors).toContain("auth metadata drifted from the seed");
    expect(validation.errors).toContain("missing L4 coverage");
    expect(validation.errors).toContain("surface mcp only has 0 tasks but the seed had 4");
  });
});

describe("authoring repair loop", () => {
  const dirs: string[] = [];

  function freshDir(): string {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-authoring-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    delete process.env.AX_EVAL_GENERATOR_FIXTURE_SEQUENCE;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("repairs an invalid draft by asking the harness for a second pass", () => {
    const dir = freshDir();
    const bad = resolve(dir, "bad.json");
    const good = resolve(dir, "good.json");
    const seed = samplePack();

    writeFileSync(bad, JSON.stringify({
      ...seed,
      auth: { type: "api-key", env: "OTHER_API_KEY", header: "x-api-key" },
      tasks: seed.tasks.map((task) => ({ ...task, allowed_surfaces: ["api"] })),
    }));
    writeFileSync(good, JSON.stringify(seed));
    process.env.AX_EVAL_GENERATOR_FIXTURE_SEQUENCE = `${bad},${good}`;

    const repaired = authorPackWithLlm({
      product: "Example",
      spec: { source: "https://docs.example.test/openapi.json" },
      seed,
      provenance: {
        harness: "codex",
        model: "gpt-5",
        effort: "high",
        prompt_version: "ax-eval-generator-v1",
        source_docs: ["https://docs.example.test/api"],
      },
      harness: {
        harness: "codex",
        model: "gpt-5",
        effort: "high",
      },
      authoringHints: ["Keep MCP coverage intact."],
    });

    expect(repaired.auth?.env).toBe("EXAMPLE_API_KEY");
    expect(repaired.tasks.every((task) => task.allowed_surfaces.includes("mcp"))).toBe(true);
  });
});
