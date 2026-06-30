import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "src", "cli.ts");
const PACK = resolve(ROOT, "targets", "examples", "asana", "pack.yaml");

/** Run the CLI via Node + tsx loader; return { code, out } (stdout+stderr merged). */
function runCli(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ASANA_PAT: "test-token",
        ASANA_SANDBOX_PROJECT_GID: "123",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

describe("cli arg handling", () => {
  it("top-level help prints usage with exit 0", () => {
    const { code, out } = runCli(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("usage: ax-eval");
    expect(out).toContain("generate");
  });

  it("subcommand help prints command usage with exit 0", () => {
    const { code, out } = runCli(["generate", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("usage: ax-eval generate");
    expect(out).toContain("--from <ingest.json>");
    expect(out).toContain("--deterministic");
    expect(out).toContain("--suite");
    expect(out).toContain("docs-only mode");
    expect(out).not.toContain("unknown flag");
  });

  it("generate without --from or --suite errors with a helpful usage hint", () => {
    const { code, out } = runCli(["generate"]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/--from is required/);
  });

  it("generate without --from but with --suite + no --product errors", () => {
    const { code, out } = runCli([
      "generate",
      "--suite", "targets/suites/daeb-1.yaml",
    ]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/--product is required/);
  });

  it("an unknown command prints usage with exit 2 (not a flag error)", () => {
    const { code, out } = runCli(["frobnicate", "--offlne"]);
    expect(code).toBe(2);
    expect(out).toContain("usage: ax-eval");
    expect(out).not.toContain("unknown flag");
  });

  it("a value-flag with no value errors clearly, not with a low-level path error", () => {
    const { code, out } = runCli(["run", "--pack"]);
    expect(code).toBe(1);
    expect(out).toContain("--pack requires a value");
    expect(out).not.toContain("ERR_INVALID_ARG_TYPE");
  });

  it("audit --offline produces a readiness score", () => {
    const { code, out } = runCli(["audit", "--offline"]);
    expect(code).toBe(0);
    expect(out).toContain("Agent-readiness score");
  });
});

describe("generate provenance", () => {
  const dirs: string[] = [];
  function freshDir(): string {
    const d = mkdtempSync(resolve(tmpdir(), "ax-generate-"));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeIngest(dir: string): string {
    const path = resolve(dir, "ingest.json");
    writeFileSync(
      path,
      JSON.stringify({
        source: "https://docs.example.test/openapi.json",
        title: "Widget API",
        baseUrl: "https://api.widget.test",
        requestEnvelope: null,
        responseEnvelope: null,
        auth: { type: "api-key", header: "x-api-key" },
        constantHeaders: {},
        resources: [
          {
            name: "widgets",
            createPath: "/widgets",
            createOp: "createWidget",
            readPath: "/widgets/{id}",
            readParam: "id",
            identityField: "name",
            createFields: ["name"],
            dependsOn: [],
            canUpdate: true,
            canDelete: false,
          },
        ],
      }),
    );
    return path;
  }

  function writeRichIngest(dir: string): string {
    const path = resolve(dir, "rich-ingest.json");
    writeFileSync(path, JSON.stringify({
      source: "https://docs.example.test/openapi.json",
      title: "Widget API",
      baseUrl: "https://api.widget.test",
      requestEnvelope: null,
      responseEnvelope: null,
      auth: { type: "api-key", header: "x-api-key" },
      constantHeaders: {},
      resources: [
        { name: "tasks", createPath: "/tasks", createOp: "createTask", readPath: "/tasks/{id}", readParam: "id", identityField: "name", createFields: ["name"], dependsOn: [], canUpdate: true, canDelete: false },
        { name: "projects", createPath: "/projects", createOp: "createProject", readPath: "/projects/{id}", readParam: "id", identityField: "name", createFields: ["name"], dependsOn: [], canUpdate: true, canDelete: false },
        { name: "goals", createPath: "/goals", createOp: "createGoal", readPath: "/goals/{id}", readParam: "id", identityField: "name", createFields: ["name"], dependsOn: [], canUpdate: true, canDelete: false },
        { name: "portfolios", createPath: "/portfolios", createOp: "createPortfolio", readPath: "/portfolios/{id}", readParam: "id", identityField: "name", createFields: ["name"], dependsOn: [], canUpdate: true, canDelete: false },
        { name: "milestones", createPath: "/milestones", createOp: "createMilestone", readPath: "/milestones/{id}", readParam: "id", identityField: "name", createFields: ["name"], dependsOn: [], canUpdate: false, canDelete: false },
        { name: "sections", createPath: "/projects/{project_id}/sections", createOp: "createSection", readPath: "/sections/{id}", readParam: "id", identityField: "name", createFields: ["name"], dependsOn: ["projects"], canUpdate: false, canDelete: false },
        { name: "comments", createPath: "/tasks/{task_id}/comments", createOp: "createComment", readPath: "/comments/{id}", readParam: "id", identityField: "name", createFields: ["name"], dependsOn: ["tasks"], canUpdate: false, canDelete: false },
      ],
    }));
    return path;
  }

  function writeGraphqlIngest(dir: string): string {
    const path = resolve(dir, "graphql-ingest.json");
    writeFileSync(path, JSON.stringify({
      source: "https://api.linear.app/graphql",
      format: "introspection",
      queryType: "Query",
      mutationType: "Mutation",
      objectTypes: ["Issue", "IssuePayload"],
      mutations: [{ name: "issueCreate", isCreate: true }],
      createMutations: ["issueCreate"],
      mutationDetails: [
        {
          name: "issueCreate",
          returnTypeName: "IssuePayload",
          args: ["input"],
          argDetails: [{ name: "input", typeName: "IssueCreateInput" }],
        },
      ],
      queryTypeFields: [
        {
          name: "issue",
          typeName: "Issue",
          args: ["id"],
          argDetails: [{ name: "id", typeName: "ID" }],
        },
      ],
      typeDetails: [
        {
          name: "IssuePayload",
          fields: [{ name: "issue", typeName: "Issue", args: [], argDetails: [] }],
        },
        {
          name: "Issue",
          fields: [{ name: "title", typeName: "String", args: [], argDetails: [] }],
        },
      ],
      inputTypeDetails: [
        {
          name: "IssueCreateInput",
          fields: [{ name: "title", typeName: "String" }],
        },
      ],
    }));
    return path;
  }

  it("defaults to LLM-assisted generation provenance", () => {
    const dir = freshDir();
    const ingest = writeIngest(dir);
    const outPath = resolve(dir, "pack.yaml");
    const fixture = resolve(dir, "llm-pack.json");
    writeFileSync(
      fixture,
      JSON.stringify({
        name: "widget-generated",
        standard_set_version: "gen-test",
        run_id: "run-test",
        base_url: "https://api.widget.test",
        auth_method: "api-key",
        auth: { type: "api-key", env: "WIDGET_API_KEY", header: "x-api-key" },
        sandbox_scope: [],
        discovery: { product: "Widget", canonical_endpoint: "POST /widgets" },
        tasks: [
          {
            id: "widget-l1",
            difficulty: "L1",
            prompt: "Create a widget named {ns}.",
            allowed_surfaces: ["api", "docs"],
            oracles: [{ type: "roundtrip", readPathTemplate: "/widgets/{gid}", assertField: "name", expected: "AX {ns}" }],
          },
        ],
      }),
    );
    const { code, out } = runCli([
      "generate",
      "--from", ingest,
      "--product", "Widget",
      "--generator-harness", "codex",
      "--generator-model", "gpt-5",
      "--generator-effort", "high",
      "--out", outPath,
    ], { AX_EVAL_GENERATOR_FIXTURE: fixture });
    expect(code).toBe(0);
    expect(out).toContain("generated_by: llm-assisted");
    const yaml = readFileSync(outPath, "utf8");
    expect(yaml).toContain("generated_by: llm-assisted");
    expect(yaml).toContain("generator:");
    expect(yaml).toContain("harness: codex");
    expect(yaml).toContain("model: gpt-5");
    expect(yaml).toContain("effort: high");
  });

  it("preserves rule-derived generation with --deterministic", () => {
    const dir = freshDir();
    const ingest = writeIngest(dir);
    const outPath = resolve(dir, "pack.yaml");
    const { code } = runCli(["generate", "--deterministic", "--from", ingest, "--product", "Widget", "--out", outPath]);
    expect(code).toBe(0);
    const yaml = readFileSync(outPath, "utf8");
    expect(yaml).toContain("generated_by: deterministic@no-model");
    expect(yaml).not.toContain("generator:");
  });

  it("treats generated.full.pack.yaml as a harder 12-task preset by default", () => {
    const dir = freshDir();
    const ingest = writeRichIngest(dir);
    const outPath = resolve(dir, "widget.generated.full.pack.yaml");
    const { code } = runCli(["generate", "--deterministic", "--from", ingest, "--product", "Widget", "--out", outPath]);
    expect(code).toBe(0);
    const yaml = readFileSync(outPath, "utf8");
    expect((yaml.match(/\n  - id:/g) ?? []).length).toBe(12);
    expect((yaml.match(/difficulty: L3/g) ?? []).length).toBeGreaterThan(1);
    expect((yaml.match(/difficulty: L4/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("applies the Linear GraphQL preset surfaces to deterministic generation", () => {
    const dir = freshDir();
    const ingest = writeGraphqlIngest(dir);
    const outPath = resolve(dir, "linear.generated.pack.yaml");
    const { code } = runCli([
      "generate",
      "--deterministic",
      "--from", ingest,
      "--product", "Linear",
      "--out", outPath,
    ]);
    expect(code).toBe(0);
    const yaml = readFileSync(outPath, "utf8");
    expect(yaml).toContain("surfaces:");
    expect(yaml).toContain("sdk:");
    expect(yaml).toContain("package: \"@linear/sdk\"");
    expect(yaml).toContain("mcp:");
    expect(yaml).toContain("server: https://mcp.linear.app/mcp");
    expect(yaml).toContain("allowed_surfaces:");
    expect(yaml).toContain("- sdk");
    expect(yaml).toContain("- mcp");
    expect(yaml).not.toContain("\n  cli:");
  });
});

describe("exec-plan --surface fan-out", () => {
  const dirs: string[] = [];
  function freshDir(): string {
    const d = mkdtempSync(resolve(tmpdir(), "ax-fanout-"));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("`--surface all` fans out over auth-runnable surfaces with isolated ns + tagged files", () => {
    const dir = freshDir();
    const { code, out } = runCli(
      [
        "exec-plan", "--pack", PACK, "--skip-review", "--surface", "all", "--harness", "floor", "--attempts", "1", "--run-dir", dir,
      ],
      // Hermetic: explicitly clear the MCP OAuth creds so a developer's populated
      // .env can't leak in and make the OAuth-only surface look runnable. Empty
      // strings count as "set in process.env", so loadDotenv won't override them.
      { ASANA_MCP_CLIENT_ID: "", ASANA_MCP_CLIENT_SECRET: "", ASANA_MCP_REFRESH_TOKEN: "" },
    );
    expect(code).toBe(0);
    // asana declares sdk + mcp; api is always present. sdk inherits the PAT
    // (runnable); mcp is OAuth-only, so it's auth-blocked rather than prompted.
    expect(out).toContain("surface=api");
    expect(out).toContain("surface=sdk");
    expect(out).toContain("surface=mcp");
    const files = readdirSync(dir).sort();
    // A prompt per runnable surface, surface-tagged so they never collide.
    expect(files).toContain("prompt-floor-api.txt");
    expect(files).toContain("prompt-floor-sdk.txt");
    // The OAuth-only MCP surface emits a blocked cube cell instead of a prompt.
    expect(files).not.toContain("prompt-floor-mcp.txt");
    expect(files).toContain("run-mcp-blocked.normalized.json");
    expect(out).toContain("surface=mcp → BLOCKED (requires-oauth)");
    // Namespaces are surface-scoped so concurrent surfaces don't clobber the live product.
    expect(out).toMatch(/ns=gen-api-floor-/);
    expect(out).toMatch(/ns=gen-sdk-floor-/);
  });

  it("a single declared surface tags its artifacts; the default api surface keeps legacy paths", () => {
    const sdkDir = freshDir();
    const sdk = runCli(["exec-plan", "--pack", PACK, "--skip-review", "--surface", "sdk", "--harness", "floor", "--attempts", "1", "--run-dir", sdkDir]);
    expect(sdk.code).toBe(0);
    expect(readdirSync(sdkDir)).toContain("prompt-floor-sdk.txt");

    const apiDir = freshDir();
    const api = runCli(["exec-plan", "--pack", PACK, "--skip-review", "--harness", "floor", "--attempts", "1", "--run-dir", apiDir]);
    expect(api.code).toBe(0);
    // Default (api-only) run is byte-for-byte the legacy layout — no surface suffix.
    expect(readdirSync(apiDir)).toContain("prompt-floor.txt");
  });

  it("refuses a surface the pack does not declare, naming what is available", () => {
    const dir = freshDir();
    const { code, out } = runCli(["exec-plan", "--pack", PACK, "--skip-review", "--surface", "cli", "--run-dir", dir]);
    expect(code).toBe(1);
    expect(out).toContain("surface 'cli' is not declared");
    expect(out).toContain("declared: api, sdk, mcp");
  });

  it("rejects an unknown --surface value before doing any work", () => {
    const { code, out } = runCli(["exec-plan", "--pack", PACK, "--skip-review", "--surface", "graphql"]);
    expect(code).toBe(1);
    expect(out).toContain("--surface must be one of api|cli|sdk|mcp|all");
  });

  it("`--invoke` runs a local harness CLI and stamps the result with the harness id", () => {
    const dir = freshDir();
    const binDir = freshDir();
    const fakeClaude = resolve(binDir, "claude");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("claude fake-test");
  process.exit(0);
}
const prompt = args[args.indexOf("-p") + 1] || "";
const resultPath = /Write (\\S+run-[^\\s]+\\.json) with EXACTLY/.exec(prompt)?.[1];
const tracePath = /write (\\S+run-[^\\s]+\\.trace\\.json) as/.exec(prompt)?.[1];
if (!resultPath || !tracePath) {
  console.error("missing paths");
  process.exit(1);
}
fs.writeFileSync(resultPath, JSON.stringify({
  profile: "floor",
  ns: "fake-ns",
  surface: "api",
  discovery: { base_url_found: "", searches: [], urls_visited: [], endpoint_used: "", auth_scheme_found: "", notes: "" },
  results: {}
}, null, 2));
fs.writeFileSync(tracePath, "[]");
console.log(JSON.stringify({ ok: true }));
`,
    );
    chmodSync(fakeClaude, 0o755);

    const { code, out } = runCli(
      [
        "exec-plan", "--pack", PACK, "--skip-review", "--invoke", "--harness", "claude-code",
        "--profile", "floor", "--attempts", "1", "--run-dir", dir,
      ],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(code).toBe(0);
    expect(out).toContain("claude-code/API/floor"); // per-job progress label in the concurrency pool
    // One combined verify-generated command (no per-harness split, no --harness flag).
    expect(out).toContain("ax-eval verify-generated");
    expect(out).toContain("--html");
    expect(out).toContain("generated-eval.html");
    expect(out).not.toContain("--harness claude-code"); // verify command groups by record, not flag
    const files = readdirSync(dir).sort();
    expect(files).toContain("prompt-claude-code-floor.txt");
    expect(files).toContain("run-claude-code-floor.json");
    expect(files).toContain("run-claude-code-floor.trace.json");
    expect(files).toContain("run-claude-code-floor.transcript.jsonl");
    const executor = JSON.parse(readFileSync(resolve(dir, "run-claude-code-floor.json"), "utf8"));
    expect(executor.harness).toBe("claude-code");
    expect(executor.profile).toBe("floor");
  });

  it("runs multiple configs through the concurrency pool (parallel by default)", () => {
    const dir = freshDir();
    const binDir = freshDir();
    const fakeClaude = resolve(binDir, "claude");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("claude fake-test"); process.exit(0); }
const prompt = args[args.indexOf("-p") + 1] || "";
const resultPath = /Write (\\S+run-[^\\s]+\\.json) with EXACTLY/.exec(prompt)?.[1];
const tracePath = /write (\\S+run-[^\\s]+\\.trace\\.json) as/.exec(prompt)?.[1];
fs.writeFileSync(resultPath, JSON.stringify({ profile: "x", ns: "n", surface: "api", discovery: {}, results: {} }));
fs.writeFileSync(tracePath, "[]");
console.log(JSON.stringify({ ok: true }));
`,
    );
    chmodSync(fakeClaude, 0o755);
    const { code, out } = runCli(
      [
        "exec-plan", "--pack", PACK, "--skip-review", "--invoke", "--harness", "claude-code",
        "--profile", "low", "--profile", "high", "--attempts", "1", "--run-dir", dir,
      ],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );
    expect(code).toBe(0);
    // Two configs (low + high) ran via the pool — both files exist, and the pool
    // announces its concurrency.
    expect(out).toContain("at concurrency=2");
    const files = readdirSync(dir).sort();
    expect(files).toContain("run-claude-code-low.json");
    expect(files).toContain("run-claude-code-high.json");
  });
});
