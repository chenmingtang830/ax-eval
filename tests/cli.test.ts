import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { TargetPackSchema } from "../src/schemas.js";
import { packFileContentHash, writeApproval } from "../src/generate/review.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "src", "cli.ts");
const ARENA_CLI = resolve(ROOT, "ax-arena", "benchmark", "src", "cli.ts");
const TSX_LOADER = resolve(ROOT, "node_modules", "tsx", "dist", "loader.mjs");
const PACK = resolve(ROOT, "targets", "examples", "asana", "pack.yaml");

/** Run the CLI via Node + tsx loader; return { code, out } (stdout+stderr merged). */
function runCli(args: string[], env: Record<string, string> = {}, cwd: string = ROOT): { code: number; out: string } {
  try {
    const out = execFileSync("node", ["--import", TSX_LOADER, CLI, ...args], {
      cwd,
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

function runArenaCli(args: string[], cwd: string = ROOT): { code: number; out: string } {
  try {
    const out = execFileSync("node", ["--import", TSX_LOADER, ARENA_CLI, ...args], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: resolve(ROOT, "ax-arena", "benchmark", "tsconfig.json"),
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

  it("delegates legacy authoring help to the arena CLI", () => {
    const direct = runArenaCli(["benchmark", "audit-extracts", "--help"]);
    const delegated = runCli(["audit-extracts", "--help"]);
    expect(delegated.code).toBe(direct.code);
    expect(delegated.out).toBe(direct.out);
    expect(delegated.out).toContain("usage: ax-arena benchmark audit-extracts");
  });

  it("warns on a legacy authoring alias and preserves the arena exit status", () => {
    const direct = runArenaCli(["benchmark", "resolve-vendor"]);
    const delegated = runCli(["resolve-vendor"]);
    expect(delegated.code).toBe(direct.code);
    expect(delegated.out).toContain(
      "warning: ax-eval resolve-vendor is deprecated; use ax-arena benchmark resolve-vendor instead.",
    );
    expect(delegated.out).toContain(direct.out.trim());
  });

  it("cell help documents the stable subprocess contract", () => {
    const { code, out } = runCli(["cell", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("usage: ax-eval cell run --input <cell.json> --output <record.json>");
  });

  it("cell run uses the public schema and writes one isolated record", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-cell-cli-"));
    const binDir = mkdtempSync(resolve(tmpdir(), "ax-cell-bin-"));
    try {
      const pack = TargetPackSchema.parse({
        name: "cell-cli",
        version: "1",
        standard_set_version: "cell-cli-v1",
        run_id: "cell-cli",
        generated_by: "deterministic@no-model",
        auth_method: "none",
        auth: { type: "none" },
        base_url: "https://example.invalid",
        site_url: "",
        docs_urls: [],
        tasks: [],
      });
      const packPath = resolve(dir, "pack.yaml");
      writeFileSync(packPath, yamlStringify(pack));
      writeApproval(packPath, pack, "cli-test");
      const inputPath = resolve(dir, "cell.json");
      const outputPath = resolve(dir, "record.json");
      writeFileSync(inputPath, JSON.stringify({
        schema: "ax.evaluation-cell/v1",
        cell_id: "cell-cli-1",
        batch_id: "batch-cli",
        evaluation_set_id: "cell-cli-set",
        evaluation_set_version: pack.standard_set_version,
        target_id: "cell-cli",
        pack: { path: "pack.yaml", content_hash: packFileContentHash(packPath) },
        surface: "api",
        harness: { id: "claude-code", profile: "medium", model: "claude-test", effort: "medium" },
        trial: 1,
        source_commit_sha: "b".repeat(40),
        required_credentials: [],
        run_context: {
          cwd: dir,
          artifact_dir: "artifacts",
          invoke_timeout_ms: 10_000,
          first_action_timeout_ms: 0,
          invoke_retries: 0,
        },
      }));
      const fakeClaude = resolve(binDir, "claude");
      writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("claude fake 1.2.3"); process.exit(0); }
const prompt = args[args.indexOf("-p") + 1] || "";
const resultPath = /Write (\\S+run-[^\\s]+\\.json) with EXACTLY/.exec(prompt)?.[1];
const tracePath = /write (\\S+run-[^\\s]+\\.trace\\.json) as/.exec(prompt)?.[1];
if (!resultPath || !tracePath) process.exit(2);
fs.writeFileSync(resultPath, JSON.stringify({
  profile: "medium", ns: "cell-cli-ns", surface: "api", model: "claude-test",
  leaked: process.env.UNRELATED_VENDOR_SECRET ?? null,
  results: {}
}));
fs.writeFileSync(tracePath, JSON.stringify([{ step: 1, taskId: "task-1", action: "POST" }]));
console.log(JSON.stringify({ type: "result", subtype: "success", model: "claude-test" }));
`);
      chmodSync(fakeClaude, 0o755);

      const result = runCli(
        ["cell", "run", "--input", inputPath, "--output", outputPath],
        {
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          AX_EVAL_CLAUDE_BIN: "/ambient/wrapper/must-not-run",
          UNRELATED_VENDOR_SECRET: "must-not-leak",
        },
      );
      expect(result.code).toBe(0);
      const record = JSON.parse(readFileSync(outputPath, "utf8"));
      expect(record).toMatchObject({
        schema: "ax.normalized-cell-record/v1",
        cell_id: "cell-cli-1",
        batch_id: "batch-cli",
        model: "claude-test",
        effort: "medium",
        trial: 1,
        status: "completed",
      });
      const raw = JSON.parse(readFileSync(resolve(record.artifacts.base_dir, record.artifacts.results), "utf8"));
      expect(raw.leaked).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("automate-report help documents the guarded workflow", () => {
    const { code, out } = runCli(["automate-report", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("usage: ax-eval automate-report --company <name>");
    expect(out).toContain("--smoke-only");
    expect(out).toContain("does not auto-approve");
  });

  it("automate-report requires a company", () => {
    const { code, out } = runCli(["automate-report"]);
    expect(code).toBe(1);
    expect(out).toContain("usage: ax-eval automate-report --company <name>");
  });

  it("publication-bundle help prints command usage with exit 0", () => {
    const { code, out } = runCli(["publication-bundle", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("usage: ax-eval publication-bundle");
    expect(out).toContain("--suite <suite.yaml>");
    expect(out).toContain("--effort-profiles <a,b,c>");
    expect(out).toContain("--benchmark-root <dir>");
  });

  it("export-publication help prints command usage with exit 0", () => {
    const { code, out } = runCli(["export-publication", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("usage: ax-eval export-publication");
    expect(out).toContain("--from <publication-bundle-dir>");
    expect(out).toContain("axarena-ready JSON dataset");
  });

  it("records-diff writes deterministic Markdown", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-records-diff-"));
    try {
      const base = resolve(dir, "base.json");
      const head = resolve(dir, "head.json");
      const outPath = resolve(dir, "diff.md");
      const record = (pass: number) => ({
        schema: "ax.normalized-result/v1", surface: "api", product: "neon", harness: "codex",
        standard_set_version: "daeb-v1", generated_at: "2026-07-18T00:00:00.000Z",
        tasks_total: 7, tasks_passed: Math.round(pass * 7), pass_at_1: pass, pass_at_k: pass,
        attempts: 1, discovery_score: null, content_quality: null, profiles: ["high"],
        best_profile: "high", model: "gpt-5.6-terra", summary_kind: "aggregate",
        task_consistency_at_3: pass, pass_3_tasks: Math.round(pass * 7), pass_3_tasks_total: 7,
      });
      writeFileSync(base, JSON.stringify(record(0.5)));
      writeFileSync(head, JSON.stringify(record(0.75)));
      const result = runCli(["records-diff", "--base", base, "--head", head, "--out", outPath]);
      expect(result.code).toBe(0);
      expect(readFileSync(outPath, "utf8")).toContain("+25.0 pp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("daeb-low-pass help prints command usage with exit 0", () => {
    const { code, out } = runCli(["daeb-low-pass", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("usage: ax-eval daeb-low-pass");
    expect(out).toContain("--surface api|cli|all");
    expect(out).toContain("--codex-model <slug>");
    expect(out).toContain("--claude-model <slug>");
    expect(out).toContain("--skip-reset");
    expect(out).toContain("--benchmark-root <dir>");
  });

  it("daeb-production-rerun help prints command usage with exit 0", () => {
    const { code, out } = runCli(["daeb-production-rerun", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("usage: ax-eval daeb-production-rerun");
    expect(out).toContain("--trial-count 3");
    expect(out).toContain("--invoke-timeout seconds");
    expect(out).toContain("--skip-archive");
    expect(out).toContain("--benchmark-root <dir>");
  });

  it("requires a value for --benchmark-root", () => {
    const { code, out } = runCli(["audit-extracts", "--benchmark-root"]);
    expect(code).toBe(1);
    expect(out).toContain("flag --benchmark-root requires a value");
  });

  it("fails ambiguous benchmark roots unless --benchmark-root selects one", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-cli-benchmark-root-"));
    try {
      mkdirSync(resolve(dir, "ax-arena", "benchmark", "daeb"), { recursive: true });
      mkdirSync(resolve(dir, "benchmarks", "daeb"), { recursive: true });

      const ambiguous = runCli(["audit-extracts"], {}, dir);
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.out).toMatch(/ambiguous benchmark roots.*--benchmark-root/);

      const explicit = runCli([
        "audit-extracts",
        "--benchmark-root", "ax-arena/benchmark/daeb",
      ], {}, dir);
      expect(explicit.code).toBe(0);
      expect(explicit.out).toContain("0 vendor(s)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a legacy synthesize-suite writer destination", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-cli-benchmark-writer-"));
    try {
      mkdirSync(resolve(dir, "benchmarks", "daeb"), { recursive: true });
      const result = runCli([
        "synthesize-suite",
        "--category", "database",
        "--benchmark-root", "benchmarks/daeb",
        "--out", "benchmarks/daeb/v1/suite.yaml",
        "--deterministic",
      ], {}, dir);
      expect(result.code).toBe(1);
      expect(result.out).toMatch(/writers use only the canonical benchmark root/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generate without --from or --suite errors with a helpful usage hint", () => {
    const { code, out } = runCli(["generate"]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/--from is required/);
  });

  it("generate without --from but with --suite + no --product errors", () => {
    const { code, out } = runCli([
      "generate",
      "--suite", "ax-arena/benchmark/daeb/v1/suite.yaml",
    ]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/--product is required/);
  });

  it("extract-tasks infers category from the suite when --category is omitted", () => {
    const { code, out } = runCli([
      "extract-tasks",
      "--suite", "ax-arena/benchmark/daeb/v1/suite.yaml",
      "--vendor", "definitely-not-a-real-vendor",
    ]);
    expect(code).not.toBe(0);
    expect(out).not.toContain("--category is required");
    expect(out).toContain('No vendor card found for slug "definitely-not-a-real-vendor"');
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

  it("publication-bundle writes a manifest for a canonical-suite vendor adapter", () => {
    const outDir = mkdtempSync(resolve(tmpdir(), "ax-pub-"));
    try {
      const { code, out } = runCli([
        "publication-bundle",
        "--suite", "ax-arena/benchmark/daeb/v1/suite.yaml",
        "--vendors", "supabase",
        "--run-dir", "results/runs/does-not-exist",
        "--out", outDir,
      ]);
      expect(code).toBe(0);
      expect(out).toContain("Saved publication bundle");
      const manifest = JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf8"));
      expect(manifest.schema).toBe("ax.publication-bundle/v2");
      expect(manifest.benchmark).toBe("DAEB-1");
      expect(manifest.publication_readiness).toBe("draft");
      expect(manifest.expected_matrix.surfaces).toEqual(["api", "cli"]);
      expect(manifest.expected_matrix.harnesses).toEqual(["codex", "claude-code"]);
      expect(manifest.expected_matrix.effort_profiles).toEqual(["high"]);
      expect(manifest.quality_gates.some((gate: { id: string; status: string }) => gate.id === "matrix-completeness" && gate.status === "fail")).toBe(true);
      expect(manifest.quality_gates.some((gate: { id: string; status: string }) => gate.id === "efficiency-metrics" && gate.status === "fail")).toBe(true);
      expect(manifest.layers.static_ax).toBeTruthy();
      expect(manifest.layers.behavioral).toBeTruthy();
      expect(manifest.notes.some((note: string) => note.includes("Publication-grade bundles require both Discoverability & Readiness artifacts"))).toBe(true);
      expect(manifest.vendors).toHaveLength(1);
      expect(manifest.vendors[0].slug).toBe("supabase");
      // Pack may be absent mid-authoring (e.g. after archive, before compose-pack).
      if (manifest.vendors[0].artifacts.compiled_pack) {
        expect(manifest.vendors[0].artifacts.compiled_pack).toBe("vendors/supabase/compiled-pack.yaml");
      } else {
        expect(manifest.vendors[0].missing.some((m: string) => m.includes("pack.yaml"))).toBe(true);
      }
      expect(manifest.missing.some((m: string) => m.endsWith("competitive.html"))).toBe(true);
      // Methodology and compiled packs may exist while run artifacts remain absent.
      expect(manifest.vendors[0].missing.some((m: string) => m.includes("*.normalized.json"))).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("daeb-low-pass rejects sdk because DAEB/database v1 scope is api+cli", () => {
    const { code, out } = runCli([
      "daeb-low-pass",
      "--suite", "ax-arena/benchmark/daeb/v1/suite.yaml",
      "--vendor", "neon",
      "--surface", "sdk",
    ]);
    expect(code).toBe(1);
    expect(out).toContain('surface "sdk" is out of scope');
  });

  it("daeb-production-rerun rejects sdk because DAEB/database v1 scope is api+cli", () => {
    const { code, out } = runCli([
      "daeb-production-rerun",
      "--suite", "ax-arena/benchmark/daeb/v1/suite.yaml",
      "--vendor", "neon",
      "--surface", "sdk",
    ]);
    expect(code).toBe(1);
    expect(out).toContain('surface "sdk" is out of scope');
  });

  it("daeb-production-rerun rejects noncanonical models, trial counts, and skipped cleanup", () => {
    const model = runCli(["daeb-production-rerun", "--codex-model", "gpt-5.4"]);
    expect(model.code).toBe(1);
    expect(model.out).toContain("production models are frozen");
    const trials = runCli(["daeb-production-rerun", "--trial-count", "2"]);
    expect(trials.code).toBe(1);
    expect(trials.out).toContain("exactly 3 clean trials");
    const reset = runCli(["daeb-production-rerun", "--skip-reset"]);
    expect(reset.code).toBe(1);
    expect(reset.out).toContain("--skip-reset is not allowed");
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
  profile: "medium",
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
        "--attempts", "1", "--run-dir", dir,
      ],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(code).toBe(0);
    expect(out).toContain("claude-code/API/medium"); // per-job progress label in the concurrency pool
    // One combined verify-generated command (no per-harness split, no --harness flag).
    expect(out).toContain("ax-eval verify-generated");
    expect(out).toContain("--html");
    expect(out).toContain("generated-eval.html");
    expect(out).not.toContain("--harness claude-code"); // verify command groups by record, not flag
    const files = readdirSync(dir).sort();
    expect(files).toContain("prompt-claude-code-medium.txt");
    expect(files).toContain("run-claude-code-medium.json");
    expect(files).toContain("run-claude-code-medium.trace.json");
    expect(files).toContain("run-claude-code-medium.transcript.jsonl");
    const executor = JSON.parse(readFileSync(resolve(dir, "run-claude-code-medium.json"), "utf8"));
    expect(executor.harness).toBe("claude-code");
    expect(executor.profile).toBe("medium");
  });

  it("`--execution-mode task` runs one prompt per task and aggregates them back into a combined run", () => {
    const dir = freshDir();
    const binDir = freshDir();
    const packDir = freshDir();
    const taskPack = resolve(packDir, "task-pack.yaml");
    writeFileSync(
      taskPack,
      `
name: task-pack
run_id: gen
base_url: https://api.example.test
tasks:
  - id: task-one
    difficulty: L1
    prompt: Create task one {ns}
    allowed_surfaces: [api]
    oracles:
      - type: roundtrip
        readPathTemplate: /things/{gid}
        assertField: ok
        expected: true
  - id: task-two
    difficulty: L2
    prompt: Create task two {ns}
    allowed_surfaces: [api]
    oracles:
      - type: roundtrip
        readPathTemplate: /things/{gid}
        assertField: ok
        expected: true
`.trim(),
    );
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
const taskId = /- ([^\\s]+) \\[L\\d\\]:/.exec(prompt)?.[1];
if (!resultPath || !tracePath || !taskId) {
  console.error("missing paths or task");
  process.exit(1);
}
fs.writeFileSync(resultPath, JSON.stringify({
  profile: "medium",
  ns: "fake-ns",
  surface: "api",
  discovery: { base_url_found: "", searches: [taskId], urls_visited: [], endpoint_used: "", auth_scheme_found: "", notes: taskId },
  results: { [taskId]: { gid: taskId + "-gid" } }
}, null, 2));
fs.writeFileSync(tracePath, JSON.stringify([{ step: 1, taskId, action: "did " + taskId }], null, 2));
console.log(JSON.stringify({ ok: true }));
`,
    );
    chmodSync(fakeClaude, 0o755);

    const { code, out } = runCli(
      [
        "exec-plan", "--pack", taskPack, "--skip-review", "--invoke", "--harness", "claude-code",
        "--attempts", "1", "--execution-mode", "task", "--run-dir", dir,
      ],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(code).toBe(0);
    const files = readdirSync(dir).sort();
    expect(files).toContain("run-claude-code-medium.json");
    expect(files).toContain("run-claude-code-medium.trace.json");
    expect(files).toContain("run-claude-code-medium.invoke.json");
    expect(files.some((file) => file.startsWith("run-claude-code-medium-") && file.endsWith(".json"))).toBe(true);
    const executor = JSON.parse(readFileSync(resolve(dir, "run-claude-code-medium.json"), "utf8"));
    expect(Object.keys(executor.results).length).toBeGreaterThan(1);
    expect(Object.values(executor.results).every((value: unknown) => {
      return !!value && typeof value === "object" && typeof (value as { gid?: string }).gid === "string";
    })).toBe(true);
    const meta = JSON.parse(readFileSync(resolve(dir, "run-claude-code-medium.invoke.json"), "utf8"));
    expect(meta.executionMode).toBe("task");
    expect(Array.isArray(meta.taskMetaPaths)).toBe(true);
    expect(meta.taskMetaPaths.length).toBeGreaterThan(1);
  });

  it("rejects `--execution-mode task` without `--invoke`", () => {
    const dir = freshDir();
    const { code, out } = runCli(["exec-plan", "--pack", PACK, "--skip-review", "--execution-mode", "task", "--run-dir", dir]);
    expect(code).toBe(1);
    expect(out).toContain("--execution-mode task currently requires --invoke");
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
    // Explicit legacy profiles still run via the pool — both files exist, and the pool
    // announces its concurrency.
    expect(out).toContain("at concurrency=2");
    const files = readdirSync(dir).sort();
    expect(files).toContain("run-claude-code-low.json");
    expect(files).toContain("run-claude-code-high.json");
  });
});
