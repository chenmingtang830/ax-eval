import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as yamlStringify } from "yaml";
import { describe, expect, it } from "vitest";
import {
  NormalizedCellRecordSchema,
  TargetPackSchema,
  createRuntimeExtensionRegistry,
  loadPack,
  runCell,
  runCellWithRuntime,
  tasksForSurface,
  writeApproval,
  type CellRuntimeDependencies,
  type EvaluationCell,
  type ResetProvider,
} from "ax-eval";
import {
  arenaCellId,
  cellCredentialNames,
  cellVerificationCredentialNames,
  executeArenaCell as executeArenaCellPublic,
  executeArenaCellWithInjectedRuntime as executeArenaCell,
  isRelativePathEscape,
} from "../src/controller/cell.js";

function commitFixture(cwd: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init");
  git("config", "user.name", "Arena Test");
  git("config", "user.email", "arena@example.invalid");
  writeFileSync(resolve(cwd, ".gitignore"), "results/\n");
  git("add", ".");
  git("-c", "commit.gpgSign=false", "commit", "-m", "arena lifecycle fixture");
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

function writeCommittedPack(cwd: string, name = "example"): {
  packPath: string;
  sourceCommitSha: string;
} {
  const packPath = resolve(cwd, "pack.yaml");
  const pack = TargetPackSchema.parse({
    name,
    standard_set_version: "daeb-1",
    run_id: "daeb",
    auth: { type: "none" },
    base_url: "https://example.invalid",
    tasks: [],
  });
  writeFileSync(packPath, yamlStringify(pack));
  writeApproval(packPath, pack, "controller-test");
  return { packPath, sourceCommitSha: commitFixture(cwd) };
}

function fakeRecord(cell: EvaluationCell): ReturnType<typeof NormalizedCellRecordSchema.parse> {
  const runtimeArtifacts = resolve(cell.run_context.cwd, cell.run_context.artifact_dir);
  mkdirSync(runtimeArtifacts, { recursive: true });
  writeFileSync(resolve(runtimeArtifacts, "results.json"), "{}");
  writeFileSync(resolve(runtimeArtifacts, "trace.json"), "[]");
  writeFileSync(resolve(runtimeArtifacts, "transcript.jsonl"), "");
  writeFileSync(resolve(runtimeArtifacts, "invoke.json"), "{}");
  return NormalizedCellRecordSchema.parse({
    schema: "ax.normalized-cell-record/v1",
    surface: cell.surface,
    product: cell.target_id,
    harness: cell.harness.id,
    standard_set_version: cell.evaluation_set_version,
    generated_at: "2026-07-21T00:00:00.000Z",
    tasks_total: 0,
    tasks_passed: 0,
    pass_at_1: 0,
    pass_at_k: 0,
    attempts: 1,
    discovery_score: null,
    content_quality: null,
    profiles: [cell.harness.profile],
    best_profile: cell.harness.profile,
    model: cell.harness.model,
    harness_version_raw: "test 1.0.0",
    harness_version_semver: "1.0.0",
    run_batch_id: cell.batch_id,
    latency_ms: 1,
    total_duration_ms: 1,
    tool_call_count: null,
    token_usage: null,
    token_cost: null,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    validity_status: "valid",
    first_action_latency_ms: 1,
    transcript_event_count: 1,
    action_occurred: true,
    summary_kind: "single",
    record_id: cell.cell_id,
    cell_id: cell.cell_id,
    batch_id: cell.batch_id,
    evaluation_set_id: cell.evaluation_set_id,
    evaluation_set_version: cell.evaluation_set_version,
    pack_content_hash: cell.pack.content_hash,
    source_commit_sha: cell.source_commit_sha,
    execution_namespace: "cell-ns",
    target_id: cell.target_id,
    trial: cell.trial,
    effort: cell.harness.effort,
    requested_model: cell.harness.model,
    started_at: "2026-07-21T00:00:00.000Z",
    completed_at: "2026-07-21T00:00:01.000Z",
    status: "completed",
    error: null,
    task_results: [],
    artifacts: {
      base_dir: runtimeArtifacts,
      results: "results.json",
      trace: "trace.json",
      transcript: "transcript.jsonl",
      invoke_metadata: "invoke.json",
    },
  });
}

function cellSpec(cwd: string, packPath: string, sourceCommitSha: string, artifactName: string) {
  const artifactDir = resolve(cwd, "results", artifactName);
  return {
    cwd,
    artifactDir,
    recordPath: resolve(artifactDir, "record.json"),
    cleanupPath: resolve(artifactDir, "cleanup.json"),
    packPath,
    batchId: "batch-1",
    evaluationSetId: "daeb",
    targetId: "example",
    surface: "api" as const,
    harness: "codex" as const,
    profile: "medium" as const,
    model: "model-1",
    effort: "medium" as const,
    trial: 1,
    sourceCommitSha,
    invokeTimeoutMs: 10,
    firstActionTimeoutMs: 5,
    invokeRetries: 0,
    skipReset: false,
  };
}

describe("arena cell controller", () => {
  it("keeps API control-plane and CLI data-plane credentials out of the other surface", () => {
    const pack = TargetPackSchema.parse({
      name: "database",
      auth: { type: "bearer", env: "DATABASE_API_KEY", verify_env: "DATABASE_VERIFY_KEY" },
      base_url: "https://api.example.invalid/${SANDBOX_PROJECT}",
      sandbox_scope: [{ name: "project", env: "SANDBOX_PROJECT", required: true }],
      sql_conn: { dialect: "postgres", connection_string_env: "DATABASE_URL" },
      surfaces: {
        cli: { bin: "psql", auth: { kind: "inherit" } },
        sdk: { package: "database-sdk", auth: { kind: "inherit" } },
        mcp: { server: "database-mcp", transport: "stdio", auth: { kind: "inherit" } },
      },
      tasks: [],
    });
    const credentials = {
      DATABASE_API_KEY: "api",
      DATABASE_VERIFY_KEY: "verify",
      DATABASE_URL: "postgres://db",
      SANDBOX_PROJECT: "project",
      OPENAI_API_KEY: "openai",
      ANTHROPIC_API_KEY: "anthropic",
    };
    expect(cellCredentialNames(pack, "api", "codex", credentials)).toEqual([
      "DATABASE_API_KEY",
      "OPENAI_API_KEY",
      "SANDBOX_PROJECT",
    ]);
    expect(cellCredentialNames(pack, "cli", "claude-code", credentials)).toEqual([
      "ANTHROPIC_API_KEY",
      "DATABASE_URL",
      "SANDBOX_PROJECT",
    ]);
    expect(cellVerificationCredentialNames(pack, credentials)).toEqual([
      "DATABASE_URL",
      "DATABASE_VERIFY_KEY",
      "SANDBOX_PROJECT",
    ]);
    expect(cellVerificationCredentialNames(pack, credentials, "cli")).toEqual([
      "DATABASE_URL",
      "DATABASE_VERIFY_KEY",
      "SANDBOX_PROJECT",
    ]);
    expect(cellCredentialNames(pack, "sdk", "codex", credentials)).toEqual([
      "DATABASE_API_KEY",
      "OPENAI_API_KEY",
      "SANDBOX_PROJECT",
    ]);
    expect(cellCredentialNames(pack, "mcp", "claude-code", credentials)).toEqual([
      "ANTHROPIC_API_KEY",
      "DATABASE_API_KEY",
      "SANDBOX_PROJECT",
    ]);

    const legacy = TargetPackSchema.parse({ name: "legacy", tasks: [] });
    expect(cellCredentialNames(legacy, "api", "codex", { ASANA_PAT: "legacy-token" }))
      .toEqual(["ASANA_PAT", "OPENAI_API_KEY"]);
    expect(cellVerificationCredentialNames(legacy, { ASANA_PAT: "legacy-token" }))
      .toEqual(["ASANA_PAT"]);
  });

  it("binds every comparable matrix dimension into the cell id", () => {
    const base = {
      batchId: "batch-1",
      evaluationSetId: "daeb",
      targetId: "example",
      surface: "api" as const,
      harness: "codex" as const,
      profile: "medium" as const,
      model: "model-1",
      effort: "medium" as const,
      trial: 1,
      sourceCommitSha: "a".repeat(40),
    };
    const hash = "b".repeat(64);
    const ids = [
      arenaCellId(base, hash),
      arenaCellId({ ...base, evaluationSetId: "daeb-2" }, hash),
      arenaCellId({ ...base, model: "model-2" }, hash),
      arenaCellId({ ...base, profile: "high" }, hash),
      arenaCellId({ ...base, effort: "high" }, hash),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(isRelativePathEscape("../outside")).toBe(true);
    expect(isRelativePathEscape("..\\outside")).toBe(true);
    expect(isRelativePathEscape("..evil/inside")).toBe(false);
    expect(isRelativePathEscape("nested/inside")).toBe(false);
  });

  it("fails closed for Claude before creating a workspace or invoking a harness", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-claude-"));
    const artifactDir = resolve(cwd, "results", "cell");
    let invoked = false;

    await expect(executeArenaCellPublic({
      cwd,
      artifactDir,
      recordPath: resolve(artifactDir, "record.json"),
      cleanupPath: resolve(artifactDir, "cleanup.json"),
      packPath: resolve(cwd, "pack.yaml"),
      batchId: "batch-1",
      evaluationSetId: "daeb",
      targetId: "example",
      surface: "api",
      harness: "claude-code",
      profile: "medium",
      model: "claude-fixture",
      effort: "medium",
      trial: 1,
      sourceCommitSha: "a".repeat(40),
      invokeTimeoutMs: 10,
      firstActionTimeoutMs: 5,
      invokeRetries: 0,
      skipReset: false,
    }, {
      credentials: {},
      now: () => new Date(),
      async createRegistry() {
        throw new Error("must not create a registry");
      },
      async runCell() {
        invoked = true;
        throw new Error("must not invoke");
      },
    })).rejects.toThrow(/trusted workflow OS sandbox/);

    expect(invoked).toBe(false);
    expect(existsSync(artifactDir)).toBe(false);
  });

  it("fails closed for direct Codex execution until trusted workflow isolation lands", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-direct-codex-"));
    const artifactDir = resolve(cwd, "results", "cell");
    await expect(executeArenaCellPublic({
      cwd,
      artifactDir,
      recordPath: resolve(artifactDir, "record.json"),
      cleanupPath: resolve(artifactDir, "cleanup.json"),
      packPath: resolve(cwd, "pack.yaml"),
      batchId: "batch-1",
      evaluationSetId: "daeb",
      targetId: "example",
      surface: "api",
      harness: "codex",
      profile: "medium",
      model: "gpt-fixture",
      effort: "medium",
      trial: 1,
      sourceCommitSha: "a".repeat(40),
      invokeTimeoutMs: 10,
      firstActionTimeoutMs: 5,
      invokeRetries: 0,
      skipReset: false,
    }, {
      credentials: {},
      now: () => new Date(),
      createRegistry: async () => createRuntimeExtensionRegistry(),
      runCell,
    })).rejects.toThrow(/trusted workflow OS sandbox/);
    expect(existsSync(artifactDir)).toBe(false);
  });
});

describe("arena cell controller: git-backed lifecycle integrity", { timeout: 20_000 }, () => {
  it("rejects uncommitted or symlinked canonical benchmark inputs before invocation", async () => {
    for (const mode of ["changed", "symlink"] as const) {
      const cwd = mkdtempSync(resolve(tmpdir(), `ax-arena-controller-input-${mode}-`));
      const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
      if (mode === "changed") {
        writeFileSync(packPath, `${readFileSync(packPath, "utf8")}\n# uncommitted\n`);
      } else {
        const sidecar = resolve(cwd, "pack.approval.json");
        const outside = resolve(cwd, "approval-copy.json");
        copyFileSync(sidecar, outside);
        rmSync(sidecar);
        symlinkSync(outside, sidecar);
      }
      const spec = cellSpec(cwd, packPath, sourceCommitSha, `input-${mode}`);
      let invoked = false;
      await expect(executeArenaCell(spec, {
        credentials: { OPENAI_API_KEY: "host-secret" },
        now: () => new Date(),
        async createRegistry() {
          return createRuntimeExtensionRegistry();
        },
        async runCell() {
          invoked = true;
          throw new Error("must not invoke");
        },
      })).rejects.toThrow(mode === "changed" ? /canonical pack approval is invalid/ : /regular non-symlink/);
      expect(invoked).toBe(false);
      expect(existsSync(spec.artifactDir)).toBe(false);
    }
  });

  it("rejects symlinked output parents before invocation", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-output-symlink-"));
    const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
    const outside = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-outside-"));
    symlinkSync(outside, resolve(cwd, "results"));
    const spec = cellSpec(cwd, packPath, sourceCommitSha, "symlink-parent");
    let invoked = false;

    await expect(executeArenaCell(spec, {
      credentials: { OPENAI_API_KEY: "host-secret" },
      now: () => new Date(),
      async createRegistry() {
        return createRuntimeExtensionRegistry();
      },
      async runCell() {
        invoked = true;
        throw new Error("must not invoke");
      },
    })).rejects.toThrow(/parent must be a real directory/);

    expect(invoked).toBe(false);
  });

  it("rejects output paths under protected source trees", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-source-output-"));
    const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
    for (const artifactDir of [
      resolve(cwd, "src", "cell-output"),
      resolve(cwd, "ax-arena"),
      resolve(cwd, ".git", "cell-output"),
      resolve(cwd, ".hg", "cell-output"),
      resolve(cwd, ".svn", "cell-output"),
    ]) {
      const spec = cellSpec(cwd, packPath, sourceCommitSha, "unused");
      spec.artifactDir = artifactDir;
      spec.recordPath = resolve(artifactDir, "record.json");
      spec.cleanupPath = resolve(artifactDir, "cleanup.json");
      await expect(executeArenaCell(spec, {
        credentials: { OPENAI_API_KEY: "host-secret" },
        now: () => new Date(),
        async createRegistry() {
          throw new Error("must not create registry");
        },
        async runCell() {
          throw new Error("must not invoke");
        },
      })).rejects.toThrow(/must not overlap protected source path/);
      expect(existsSync(spec.artifactDir)).toBe(false);
    }
  });

  it("keeps durable record and cleanup paths outside the harness workspace", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-workspace-output-"));
    const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
    const spec = cellSpec(cwd, packPath, sourceCommitSha, "workspace-output");
    spec.cleanupPath = resolve(spec.artifactDir, "workspace", "planted-cleanup.json");

    await expect(executeArenaCell(spec, {
      credentials: { OPENAI_API_KEY: "host-secret" },
      now: () => new Date(),
      async createRegistry() {
        throw new Error("must not create registry");
      },
      async runCell() {
        throw new Error("must not invoke");
      },
    })).rejects.toThrow(/cleanup path must remain outside the harness-writable workspace/);
  });

  it("runs a canonical committed legacy-approved DAEB pack through the real cell runtime", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-canonical-"));
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const packPath = resolve(cwd, "pack.yaml");
    copyFileSync(resolve(repo, "ax-arena/benchmark/daeb/v1/packs/neon/pack.yaml"), packPath);
    copyFileSync(
      resolve(repo, "ax-arena/benchmark/daeb/v1/packs/neon/pack.approval.json"),
      resolve(cwd, "pack.approval.json"),
    );
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
    git("init");
    git("config", "user.name", "Arena Test");
    git("config", "user.email", "arena@example.invalid");
    writeFileSync(resolve(cwd, ".gitignore"), "results/\n");
    git("add", ".");
    git("-c", "commit.gpgSign=false", "commit", "-m", "canonical pack fixture");
    const sourceCommitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const pack = loadPack(packPath);
    const credentials = Object.fromEntries([...new Set([
      ...cellCredentialNames(pack, "api", "codex", {}),
      ...cellVerificationCredentialNames(pack, {}),
    ])].map((name) => [name, "fixture-value"]));
    let tick = 0;
    const runtime: CellRuntimeDependencies = {
      now: () => new Date(`2026-07-21T00:00:0${tick++}.000Z`),
      detectHarness: () => ({ ok: true, command: "codex", version: "codex 1.2.3" }),
      provisionHarness: async () => ({ env: {}, meta: { kind: "test" } }),
      invokeHarness: async (options) => {
        const tasks = tasksForSurface(options.pack, options.surface);
        writeFileSync(options.paths.resultsPath, JSON.stringify({
          profile: options.profile,
          harness: options.harness,
          model: options.model,
          ns: options.ns,
          surface: options.surface,
          results: Object.fromEntries(tasks.map((task) => [task.id, { gid: `${task.id}-gid` }])),
        }));
        writeFileSync(options.paths.tracePath, JSON.stringify(tasks.map((task, index) => ({
          step: index + 1,
          taskId: task.id,
          action: "POST",
          method: "POST",
          path: "/sql",
        }))));
        writeFileSync(options.paths.transcriptPath, "");
        writeFileSync(options.paths.metaPath, "{}");
        return {
          harness: options.harness,
          ok: true,
          exitCode: 0,
          signal: null,
          profile: options.profile,
          surface: options.surface,
          requestedModel: options.model,
          effort: options.effort,
          stdoutPath: options.paths.stdoutPath,
          stderrPath: options.paths.stderrPath,
          transcriptPath: options.paths.transcriptPath,
          metaPath: options.paths.metaPath,
          resultsPath: options.paths.resultsPath,
          tracePath: options.paths.tracePath,
          attempts: 1,
          durationMs: 10,
          validity_status: "valid",
          first_action_latency_ms: 1,
          transcript_event_count: 1,
          action_occurred: true,
          metrics: {
            harness_version_raw: "codex 1.2.3",
            harness_version_semver: "1.2.3",
            run_batch_id: options.runBatchId ?? null,
            duration_ms: 10,
            total_duration_ms: 10,
            cost_usd: null,
            token_usage: null,
            num_turns: 1,
          },
        };
      },
      verificationClient: () => ({} as never),
      verify: async (verifiedPack, executor, _client, cell) => tasksForSurface(verifiedPack, cell.surface)
        .map((task) => ({
          taskId: task.id,
          difficulty: task.difficulty,
          profile: executor.profile,
          success: true,
          oracleResults: [{ type: "roundtrip", passed: true, detail: "fixture verified" }],
          error: null,
          na: false,
        })),
    };
    const artifactDir = resolve(cwd, "results", "cell");
    const execution = await executeArenaCell({
      cwd,
      artifactDir,
      recordPath: resolve(artifactDir, "record.json"),
      cleanupPath: resolve(artifactDir, "cleanup.json"),
      packPath,
      batchId: "batch-1",
      evaluationSetId: "DAEB-1",
      targetId: "neon",
      surface: "api",
      harness: "codex",
      profile: "medium",
      model: "gpt-fixture",
      effort: "medium",
      trial: 1,
      sourceCommitSha,
      invokeTimeoutMs: 10,
      firstActionTimeoutMs: 5,
      invokeRetries: 0,
      skipReset: true,
    }, {
      credentials,
      now: () => new Date("2026-07-21T00:00:10.000Z"),
      runCell: (cell, options) => runCellWithRuntime(cell, options, runtime),
      async createRegistry() {
        return createRuntimeExtensionRegistry();
      },
    });

    expect(execution.record.status).toBe("completed");
    expect(execution.record.pack_content_hash).toBe(execution.cell.pack.content_hash);
    expect(execution.cleanup.status).toBe("skipped");
  });

  it("refuses to overwrite a persisted immutable cell record", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-existing-"));
    const packPath = resolve(cwd, "pack.yaml");
    const artifactDir = resolve(cwd, "results", "cell");
    const recordPath = resolve(artifactDir, "record.normalized.json");
    mkdirSync(artifactDir, { recursive: true });
    const pack = TargetPackSchema.parse({
      name: "example",
      standard_set_version: "daeb-1",
      auth: { type: "none" },
      tasks: [],
    });
    writeFileSync(packPath, yamlStringify(pack));
    writeApproval(packPath, pack, "controller-test");
    const sourceCommitSha = commitFixture(cwd);
    writeFileSync(recordPath, "persisted");
    let invoked = false;

    await expect(executeArenaCell({
      cwd,
      artifactDir,
      recordPath,
      cleanupPath: resolve(artifactDir, "cleanup.json"),
      packPath,
      batchId: "batch-1",
      evaluationSetId: "daeb",
      targetId: "example",
      surface: "api",
      harness: "codex",
      profile: "medium",
      model: "model-1",
      effort: "medium",
      trial: 1,
      sourceCommitSha,
      invokeTimeoutMs: 10,
      firstActionTimeoutMs: 5,
      invokeRetries: 0,
      skipReset: false,
    }, {
      credentials: {},
      now: () => new Date(),
      async createRegistry() {
        return createRuntimeExtensionRegistry();
      },
      async runCell() {
        invoked = true;
        throw new Error("must not run");
      },
    })).rejects.toThrow(/refusing to overwrite existing immutable cell artifact/);
    expect(invoked).toBe(false);
  });

  it("persists the runCell record before selecting, planning, and executing cleanup", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-"));
    const packPath = resolve(cwd, "pack.yaml");
    const artifactDir = resolve(cwd, "results", "cell");
    const recordPath = resolve(artifactDir, "record.normalized.json");
    const cleanupPath = resolve(artifactDir, "cleanup.json");
    const pack = TargetPackSchema.parse({
      name: "convex",
      standard_set_version: "daeb-1",
      run_id: "daeb",
      auth: { type: "none" },
      base_url: "https://example.invalid",
      tasks: [],
    });
    writeFileSync(packPath, yamlStringify(pack));
    writeApproval(packPath, pack, "controller-test");
    const sourceCommitSha = commitFixture(cwd);
    const events: string[] = [];
    const registries: object[] = [];
    const reset: ResetProvider = {
      id: "test-reset",
      version: "1.0.0",
      matches() {
        expect(readFileSync(recordPath, "utf8")).toContain("ax.normalized-cell-record/v1");
        events.push("select");
        return true;
      },
      async plan(context) {
        events.push("plan");
        expect(context.namespace).toBe("cell-ns");
        expect(context.credentials).toEqual({
          CONVEX_MANAGEMENT_TOKEN: "opaque-management-secret",
        });
        return {
          summary: "delete one",
          resources: [`example:cell-ns:${context.credentials.CONVEX_MANAGEMENT_TOKEN}`],
        };
      },
      async execute(plan) {
        events.push("execute");
        return { supported: true, message: "deleted", deleted: plan.resources, errors: [] };
      },
    };
    let capturedCell: EvaluationCell | undefined;
    const result = await executeArenaCell({
      cwd,
      artifactDir,
      recordPath,
      cleanupPath,
      packPath,
      batchId: "batch-1",
      evaluationSetId: "daeb",
      targetId: "convex",
      surface: "api",
      harness: "codex",
      profile: "medium",
      model: "model-1",
      effort: "medium",
      trial: 1,
      sourceCommitSha,
      invokeTimeoutMs: 10,
      firstActionTimeoutMs: 5,
      invokeRetries: 0,
      skipReset: false,
    }, {
      credentials: {
        OPENAI_API_KEY: "  host-secret  ",
        CONVEX_MANAGEMENT_TOKEN: "  opaque-management-secret  ",
      },
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      async createRegistry() {
        events.push("registry");
        const registry = createRuntimeExtensionRegistry({ resetProviders: [reset] });
        registries.push(registry);
        return registry;
      },
      async runCell(cell, options) {
        expect(options.approval).toMatchObject({
          allowCommittedLegacy: true,
          sourceRepositoryRoot: cwd,
          sourcePackPath: packPath,
        });
        expect(options.credentials).toEqual({ OPENAI_API_KEY: "host-secret" });
        expect(options.verificationCredentials).toEqual({});
        capturedCell = cell;
        events.push("run");
        const runtimeArtifacts = resolve(cell.run_context.cwd, cell.run_context.artifact_dir);
        mkdirSync(runtimeArtifacts, { recursive: true });
        writeFileSync(resolve(runtimeArtifacts, "results.json"), JSON.stringify({ ns: "attacker-selected-ns", results: {} }));
        writeFileSync(resolve(runtimeArtifacts, "trace.json"), "[]");
        writeFileSync(resolve(runtimeArtifacts, "transcript.jsonl"), "");
        writeFileSync(resolve(runtimeArtifacts, "invoke.json"), "{}");
        return NormalizedCellRecordSchema.parse({
          schema: "ax.normalized-cell-record/v1",
          surface: "api",
          product: "convex",
          harness: "codex",
          standard_set_version: "daeb-1",
          generated_at: "2026-07-21T00:00:00.000Z",
          tasks_total: 0,
          tasks_passed: 0,
          pass_at_1: 0,
          pass_at_k: 0,
          attempts: 1,
          discovery_score: null,
          content_quality: null,
          profiles: ["medium"],
          best_profile: "medium",
          model: "model-1",
          harness_version_raw: "test 1.0.0",
          harness_version_semver: "1.0.0",
          run_batch_id: "batch-1",
          latency_ms: 1,
          total_duration_ms: 1,
          tool_call_count: null,
          token_usage: null,
          token_cost: null,
          cost_usd: null,
          tokens_in: null,
          tokens_out: null,
          validity_status: "valid",
          first_action_latency_ms: 1,
          transcript_event_count: 1,
          action_occurred: true,
          summary_kind: "single",
          record_id: cell.cell_id,
          cell_id: cell.cell_id,
          batch_id: cell.batch_id,
          evaluation_set_id: cell.evaluation_set_id,
          evaluation_set_version: cell.evaluation_set_version,
          pack_content_hash: cell.pack.content_hash,
          source_commit_sha: cell.source_commit_sha,
          execution_namespace: "cell-ns",
          target_id: cell.target_id,
          trial: cell.trial,
          effort: cell.harness.effort,
          requested_model: cell.harness.model,
          started_at: "2026-07-21T00:00:00.000Z",
          completed_at: "2026-07-21T00:00:01.000Z",
          status: "completed",
          error: null,
          task_results: [],
          artifacts: {
            base_dir: runtimeArtifacts,
            results: "results.json",
            trace: "trace.json",
            transcript: "transcript.jsonl",
            invoke_metadata: "invoke.json",
          },
        });
      },
    });

    expect(capturedCell?.required_credentials).toEqual(["OPENAI_API_KEY"]);
    expect(events).toEqual(["registry", "run", "select", "plan", "execute"]);
    expect(result.cleanup.status).toBe("confirmed");
    expect(JSON.parse(readFileSync(cleanupPath, "utf8"))).toMatchObject({
      schema: "ax.arena-cell-cleanup/v1",
      status: "confirmed",
      namespace: "cell-ns",
      provider: { id: "test-reset", version: "1.0.0" },
    });
    expect(readFileSync(cleanupPath, "utf8")).not.toContain("opaque-management-secret");

    const artifactDir2 = resolve(cwd, "results", "cell-2");
    const recordPath2 = resolve(artifactDir2, "record.normalized.json");
    const cleanupPath2 = resolve(artifactDir2, "cleanup.json");
    const leakingReset: ResetProvider = {
      id: "leaking-reset",
      version: "1.0.0",
      matches: () => true,
      async plan(context) {
        throw new Error(`driver rejected ${context.credentials.CONVEX_MANAGEMENT_TOKEN}`);
      },
      async execute() {
        throw new Error("must not execute");
      },
    };
    const second = await executeArenaCell({
      cwd,
      artifactDir: artifactDir2,
      recordPath: recordPath2,
      cleanupPath: cleanupPath2,
      packPath,
      batchId: "batch-1",
      evaluationSetId: "daeb",
      targetId: "convex",
      surface: "api",
      harness: "codex",
      profile: "medium",
      model: "model-1",
      effort: "medium",
      trial: 2,
      sourceCommitSha,
      invokeTimeoutMs: 10,
      firstActionTimeoutMs: 5,
      invokeRetries: 0,
      skipReset: false,
    }, {
      credentials: {
        OPENAI_API_KEY: "  host-secret  ",
        CONVEX_MANAGEMENT_TOKEN: "  opaque-management-secret  ",
      },
      now: () => new Date("2026-07-21T00:00:02.000Z"),
      async createRegistry() {
        const registry = createRuntimeExtensionRegistry({ resetProviders: [leakingReset] });
        registries.push(registry);
        return registry;
      },
      async runCell(cell) {
        expect(cell.required_credentials).not.toContain("CONVEX_MANAGEMENT_TOKEN");
        const runtimeArtifacts = resolve(cell.run_context.cwd, cell.run_context.artifact_dir);
        mkdirSync(runtimeArtifacts, { recursive: true });
        writeFileSync(resolve(runtimeArtifacts, "results.json"), JSON.stringify({ ns: "cell-ns", results: {} }));
        writeFileSync(resolve(runtimeArtifacts, "trace.json"), "[]");
        writeFileSync(resolve(runtimeArtifacts, "transcript.jsonl"), "");
        writeFileSync(resolve(runtimeArtifacts, "invoke.json"), "{}");
        return NormalizedCellRecordSchema.parse({
          ...result.record,
          record_id: cell.cell_id,
          cell_id: cell.cell_id,
          trial: cell.trial,
          artifacts: { ...result.record.artifacts, base_dir: runtimeArtifacts },
        });
      },
    });
    expect(registries).toHaveLength(2);
    expect(registries[0]).not.toBe(registries[1]);
    expect(second.cleanup.status).toBe("unconfirmed");
    expect(readFileSync(cleanupPath2, "utf8")).not.toContain("opaque-management-secret");
    expect(readFileSync(cleanupPath2, "utf8")).toContain("<redacted>");
  });

  it("never selects cleanup when durable record publication fails", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-record-failure-"));
    const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
    const spec = cellSpec(cwd, packPath, sourceCommitSha, "record-failure");
    let selected = false;
    const reset: ResetProvider = {
      id: "must-not-select",
      version: "1.0.0",
      matches() {
        selected = true;
        return true;
      },
      async plan() {
        throw new Error("must not plan");
      },
      async execute() {
        throw new Error("must not execute");
      },
    };

    await expect(executeArenaCell(spec, {
      credentials: { OPENAI_API_KEY: "host-secret" },
      now: () => new Date(),
      async createRegistry() {
        return createRuntimeExtensionRegistry({ resetProviders: [reset] });
      },
      async runCell(cell) {
        const record = fakeRecord(cell);
        writeFileSync(spec.recordPath, "competing writer");
        return record;
      },
    })).rejects.toThrow(/refusing to overwrite persisted artifact/);

    expect(selected).toBe(false);
    expect(existsSync(spec.cleanupPath)).toBe(false);
  });

  it("rechecks cleanup evidence publication before selecting a reset provider", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-cleanup-race-"));
    const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
    const spec = cellSpec(cwd, packPath, sourceCommitSha, "cleanup-race");
    let selected = false;
    const reset: ResetProvider = {
      id: "must-not-select",
      version: "1.0.0",
      matches() {
        selected = true;
        return true;
      },
      async plan() {
        throw new Error("must not plan");
      },
      async execute() {
        throw new Error("must not execute");
      },
    };

    await expect(executeArenaCell(spec, {
      credentials: { OPENAI_API_KEY: "host-secret" },
      now: () => new Date(),
      async createRegistry() {
        return createRuntimeExtensionRegistry({ resetProviders: [reset] });
      },
      async runCell(cell) {
        const record = fakeRecord(cell);
        writeFileSync(spec.cleanupPath, "planted cleanup evidence");
        return record;
      },
    })).rejects.toThrow(/cleanup evidence path changed during cell execution/);

    expect(JSON.parse(readFileSync(spec.recordPath, "utf8")).schema)
      .toBe("ax.normalized-cell-record/v1");
    expect(selected).toBe(false);
    expect(readFileSync(spec.cleanupPath, "utf8")).toBe("planted cleanup evidence");
  });

  it("persists record and cleanup before rejecting post-run source tampering", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-source-tamper-"));
    const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
    const spec = cellSpec(cwd, packPath, sourceCommitSha, "source-tamper");
    const reset: ResetProvider = {
      id: "tamper-cleanup",
      version: "1.0.0",
      matches: () => true,
      async plan() {
        return { summary: "one resource", resources: ["resource:cell-ns"] };
      },
      async execute(plan) {
        return { supported: true, message: "deleted", deleted: plan.resources, errors: [] };
      },
    };

    await expect(executeArenaCell(spec, {
      credentials: { OPENAI_API_KEY: "host-secret" },
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      async createRegistry() {
        return createRuntimeExtensionRegistry({ resetProviders: [reset] });
      },
      async runCell(cell) {
        const record = fakeRecord(cell);
        writeFileSync(packPath, `${readFileSync(packPath, "utf8")}\n# changed during run\n`);
        return record;
      },
    })).rejects.toThrow(/source integrity changed during cell execution/);

    const recordBytes = readFileSync(spec.recordPath);
    expect(JSON.parse(recordBytes.toString("utf8")).schema).toBe("ax.normalized-cell-record/v1");
    expect(JSON.parse(readFileSync(spec.cleanupPath, "utf8"))).toMatchObject({
      schema: "ax.arena-cell-cleanup/v1",
      record_sha256: createHash("sha256").update(recordBytes).digest("hex"),
      status: "unconfirmed",
      plan: { resources: ["resource:cell-ns"] },
      errors: [expect.stringMatching(/source integrity changed during cell execution/)],
    });
  });

  it("rejects record artifacts outside the isolated runtime directory", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-artifact-escape-"));
    const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
    const spec = cellSpec(cwd, packPath, sourceCommitSha, "artifact-escape");

    await expect(executeArenaCell(spec, {
      credentials: { OPENAI_API_KEY: "host-secret" },
      now: () => new Date(),
      async createRegistry() {
        return createRuntimeExtensionRegistry();
      },
      async runCell(cell) {
        const record = fakeRecord(cell);
        return { ...record, artifacts: { ...record.artifacts, base_dir: cwd } };
      },
    })).rejects.toThrow(/artifact base outside the isolated cell workspace/);

    expect(existsSync(spec.recordPath)).toBe(false);
    expect(existsSync(spec.cleanupPath)).toBe(false);
  });

  it("rejects a harness-swapped artifact directory", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-artifact-swap-"));
    const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
    const spec = cellSpec(cwd, packPath, sourceCommitSha, "artifact-swap");

    await expect(executeArenaCell(spec, {
      credentials: { OPENAI_API_KEY: "host-secret" },
      now: () => new Date(),
      async createRegistry() {
        return createRuntimeExtensionRegistry();
      },
      async runCell(cell) {
        const record = fakeRecord(cell);
        const runtimeArtifacts = resolve(cell.run_context.cwd, cell.run_context.artifact_dir);
        renameSync(runtimeArtifacts, `${runtimeArtifacts}-moved`);
        mkdirSync(runtimeArtifacts);
        for (const [name, value] of ([
          ["results.json", "{}"],
          ["trace.json", "[]"],
          ["transcript.jsonl", ""],
          ["invoke.json", "{}"],
        ] as const)) writeFileSync(resolve(runtimeArtifacts, name), value);
        return record;
      },
    })).rejects.toThrow(/artifact directory identity changed/);

    expect(existsSync(spec.recordPath)).toBe(false);
  });

  it("rejects a normalized record that spoofs immutable cell identity", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-record-spoof-"));
    const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
    const spec = cellSpec(cwd, packPath, sourceCommitSha, "record-spoof");

    await expect(executeArenaCell(spec, {
      credentials: { OPENAI_API_KEY: "host-secret" },
      now: () => new Date(),
      async createRegistry() {
        return createRuntimeExtensionRegistry();
      },
      async runCell(cell) {
        return { ...fakeRecord(cell), batch_id: "different-batch" };
      },
    })).rejects.toThrow(/record outside the immutable cell identity/);

    expect(existsSync(spec.recordPath)).toBe(false);
    expect(existsSync(spec.cleanupPath)).toBe(false);
  });

  it.each([
    ["schema", "host-secret"],
    ["identity", "zz"],
  ] as const)("keeps %s validation failures free of returned credential values", async (mode, secret) => {
    const cwd = mkdtempSync(resolve(tmpdir(), `ax-arena-controller-record-${mode}-`));
    const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
    const spec = cellSpec(cwd, packPath, sourceCommitSha, `record-${mode}`);
    let thrown: unknown;
    try {
      await executeArenaCell(spec, {
        credentials: { OPENAI_API_KEY: secret },
        now: () => new Date(),
        async createRegistry() {
          return createRuntimeExtensionRegistry();
        },
        async runCell(cell) {
          const record = fakeRecord(cell);
          return (mode === "schema"
            ? { ...record, status: secret }
            : { ...record, batch_id: secret }) as never;
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toMatch(mode === "schema" ? /invalid normalized record/ : /credential material/);
    expect(String(thrown)).not.toContain(secret);
    expect(existsSync(spec.recordPath)).toBe(false);
    expect(existsSync(spec.cleanupPath)).toBe(false);
  });

  it.each(["set", "profiles", "best", "namespace", "failed-namespace"] as const)(
    "binds completed record provenance: %s",
    async (mode) => {
      const cwd = mkdtempSync(resolve(tmpdir(), `ax-arena-controller-provenance-${mode}-`));
      const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
      const spec = cellSpec(cwd, packPath, sourceCommitSha, `provenance-${mode}`);
      await expect(executeArenaCell(spec, {
        credentials: { OPENAI_API_KEY: "host-secret" },
        now: () => new Date(),
        async createRegistry() {
          return createRuntimeExtensionRegistry();
        },
        async runCell(cell) {
          const record = fakeRecord(cell);
          if (mode === "set") return { ...record, standard_set_version: "other-set" };
          if (mode === "profiles") return { ...record, profiles: ["high"] };
          if (mode === "best") return { ...record, best_profile: "high" };
          const { execution_namespace: _removed, ...withoutNamespace } = record;
          return mode === "failed-namespace"
            ? { ...withoutNamespace, status: "failed" as const, error: { stage: "invoke" as const, message: "failed" } }
            : withoutNamespace;
        },
      })).rejects.toThrow(/immutable cell identity|best_profile|execution namespace/);
      expect(existsSync(spec.recordPath)).toBe(false);
    },
  );

  it("rejects unbounded namespaces and credential material in returned records", async () => {
    for (const mode of ["namespace", "secret", "escaped-secret", "short-secret"] as const) {
      const cwd = mkdtempSync(resolve(tmpdir(), `ax-arena-controller-record-${mode}-`));
      const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
      const spec = cellSpec(cwd, packPath, sourceCommitSha, `record-${mode}`);
      const effectiveSecret = mode === "escaped-secret"
        ? "quote\"line\nsecret"
        : mode === "short-secret" ? "zz" : "host-secret";
      let thrown: unknown;
      try {
        await executeArenaCell(spec, {
          credentials: { OPENAI_API_KEY: `  ${effectiveSecret}  ` },
          now: () => new Date(),
          async createRegistry() {
            return createRuntimeExtensionRegistry();
          },
          async runCell(cell) {
            const record = fakeRecord(cell);
            return mode === "namespace"
              ? { ...record, execution_namespace: "../outside" }
              : { ...record, error: { stage: "verify" as const, message: `leaked ${effectiveSecret}` } };
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(String(thrown)).toMatch(mode === "namespace" ? /unbounded execution namespace/ : /credential material/);
      if (mode !== "namespace") expect(String(thrown)).not.toContain(effectiveSecret);
      expect(existsSync(spec.recordPath)).toBe(false);
    }
  });

  it("freezes cleanup plans and preserves them when provider execution throws", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-plan-mutation-"));
    const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
    const spec = cellSpec(cwd, packPath, sourceCommitSha, "plan-mutation");
    const reset: ResetProvider = {
      id: "mutating-reset",
      version: "1.0.0",
      matches: () => true,
      async plan() {
        return { summary: "one resource", resources: ["resource:cell-ns"] };
      },
      async execute(plan) {
        (plan.resources as string[]).push("resource:extra");
        throw new Error("mutation unexpectedly succeeded");
      },
    };

    const execution = await executeArenaCell(spec, {
      credentials: { OPENAI_API_KEY: "host-secret" },
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      async createRegistry() {
        return createRuntimeExtensionRegistry({ resetProviders: [reset] });
      },
      async runCell(cell) {
        return fakeRecord(cell);
      },
    });

    expect(execution.cleanup).toMatchObject({
      status: "unconfirmed",
      plan: { summary: "one resource", resources: ["resource:cell-ns"] },
    });
    expect(execution.cleanup.message).toMatch(/cleanup failed/);
  });

  it("persists an unconfirmed sidecar when a provider returns oversized evidence", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-evidence-bound-"));
    const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
    const spec = cellSpec(cwd, packPath, sourceCommitSha, "evidence-bound");
    const reset: ResetProvider = {
      id: "oversized-evidence",
      version: "1.0.0",
      matches: () => true,
      async plan() {
        return { summary: "one resource", resources: ["resource:cell-ns"] };
      },
      async execute() {
        return {
          supported: true,
          message: "invalid oversized evidence",
          deleted: Array.from({ length: 101 }, (_, index) => `resource:${index}`),
          errors: [],
        };
      },
    };

    const execution = await executeArenaCell(spec, {
      credentials: { OPENAI_API_KEY: "host-secret" },
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      async createRegistry() {
        return createRuntimeExtensionRegistry({ resetProviders: [reset] });
      },
      async runCell(cell) {
        return fakeRecord(cell);
      },
    });

    expect(execution.cleanup).toMatchObject({
      status: "unconfirmed",
      plan: { resources: ["resource:cell-ns"] },
    });
    expect(execution.cleanup.message).toMatch(/invalid cleanup evidence/);
    expect(JSON.parse(readFileSync(spec.cleanupPath, "utf8")).status).toBe("unconfirmed");
  });

  it("rejects an oversized provider identity before planning cleanup", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-provider-bound-"));
    const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
    const spec = cellSpec(cwd, packPath, sourceCommitSha, "provider-bound");
    let planned = false;
    const reset: ResetProvider = {
      id: "x".repeat(4_097),
      version: "1.0.0",
      matches: () => true,
      async plan() {
        planned = true;
        return { summary: "must not plan", resources: [] };
      },
      async execute() {
        throw new Error("must not execute");
      },
    };

    const execution = await executeArenaCell(spec, {
      credentials: { OPENAI_API_KEY: "host-secret" },
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      async createRegistry() {
        return createRuntimeExtensionRegistry({ resetProviders: [reset] });
      },
      async runCell(cell) {
        return fakeRecord(cell);
      },
    });
    expect(planned).toBe(false);
    expect(execution.cleanup.status).toBe("unconfirmed");
    expect(execution.cleanup.provider).toBeUndefined();
    expect(JSON.parse(readFileSync(spec.cleanupPath, "utf8")).status).toBe("unconfirmed");
  });

  it("keeps distinct secret-bearing cleanup resources unique after redaction", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-redaction-identity-"));
    const { packPath, sourceCommitSha } = writeCommittedPack(cwd);
    const spec = cellSpec(cwd, packPath, sourceCommitSha, "redaction-identity");
    const prefix = "abcd".repeat(1_000);
    const resources = [`${prefix}-one`, `${prefix}-two`];
    const reset: ResetProvider = {
      id: "redacting-reset",
      version: "1.0.0",
      matches: () => true,
      async plan() {
        return { summary: "two resources", resources };
      },
      async execute(plan) {
        return { supported: true, message: "deleted", deleted: plan.resources, errors: [] };
      },
    };

    const execution = await executeArenaCell(spec, {
      credentials: { OPENAI_API_KEY: "abcd" },
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      async createRegistry() {
        return createRuntimeExtensionRegistry({ resetProviders: [reset] });
      },
      async runCell(cell) {
        return fakeRecord(cell);
      },
    });
    expect(execution.cleanup.status).toBe("confirmed");
    expect(new Set(execution.cleanup.plan?.resources).size).toBe(2);
    expect(JSON.stringify(execution.cleanup)).not.toContain("abcd");
  });

  it.each([
    ["empty", []],
    ["partial", ["resource:cell-ns:one"]],
    ["extra", ["resource:cell-ns:one", "resource:cell-ns:two", "resource:cell-ns:extra"]],
    ["duplicate", ["resource:cell-ns:one", "resource:cell-ns:one"]],
  ])("does not confirm %s cleanup evidence that differs from the immutable plan", async (_label, deleted) => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ax-arena-controller-evidence-"));
    const packPath = resolve(cwd, "pack.yaml");
    const artifactDir = resolve(cwd, "results", "cell");
    const pack = TargetPackSchema.parse({
      name: "example",
      standard_set_version: "daeb-1",
      auth: { type: "none" },
      tasks: [],
    });
    writeFileSync(packPath, yamlStringify(pack));
    writeApproval(packPath, pack, "controller-test");
    const sourceCommitSha = commitFixture(cwd);
    const reset: ResetProvider = {
      id: "evidence-reset",
      version: "1.0.0",
      matches: () => true,
      plan: async () => ({
        summary: "two resources",
        resources: ["resource:cell-ns:one", "resource:cell-ns:two"],
      }),
      execute: async () => ({ supported: true, message: "claimed success", deleted, errors: [] }),
    };
    const execution = await executeArenaCell({
      cwd,
      artifactDir,
      recordPath: resolve(artifactDir, "record.json"),
      cleanupPath: resolve(artifactDir, "cleanup.json"),
      packPath,
      batchId: "batch-1",
      evaluationSetId: "daeb",
      targetId: "example",
      surface: "api",
      harness: "codex",
      profile: "medium",
      model: "model-1",
      effort: "medium",
      trial: 1,
      sourceCommitSha,
      invokeTimeoutMs: 10,
      firstActionTimeoutMs: 5,
      invokeRetries: 0,
      skipReset: false,
    }, {
      credentials: {},
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      async createRegistry() {
        return createRuntimeExtensionRegistry({ resetProviders: [reset] });
      },
      async runCell(cell) {
        const runtimeArtifacts = resolve(cell.run_context.cwd, cell.run_context.artifact_dir);
        mkdirSync(runtimeArtifacts, { recursive: true });
        writeFileSync(resolve(runtimeArtifacts, "results.json"), "{}");
        writeFileSync(resolve(runtimeArtifacts, "trace.json"), "[]");
        writeFileSync(resolve(runtimeArtifacts, "transcript.jsonl"), "");
        writeFileSync(resolve(runtimeArtifacts, "invoke.json"), "{}");
        return NormalizedCellRecordSchema.parse({
          schema: "ax.normalized-cell-record/v1",
          surface: "api",
          product: "example",
          harness: "codex",
          standard_set_version: "daeb-1",
          generated_at: "2026-07-21T00:00:00.000Z",
          tasks_total: 0,
          tasks_passed: 0,
          pass_at_1: 0,
          pass_at_k: 0,
          attempts: 1,
          discovery_score: null,
          content_quality: null,
          profiles: ["medium"],
          best_profile: "medium",
          model: "model-1",
          harness_version_raw: "test 1.0.0",
          harness_version_semver: "1.0.0",
          run_batch_id: cell.batch_id,
          latency_ms: 1,
          total_duration_ms: 1,
          tool_call_count: null,
          token_usage: null,
          token_cost: null,
          cost_usd: null,
          tokens_in: null,
          tokens_out: null,
          validity_status: "valid",
          first_action_latency_ms: 1,
          transcript_event_count: 1,
          action_occurred: true,
          summary_kind: "single",
          record_id: cell.cell_id,
          cell_id: cell.cell_id,
          batch_id: cell.batch_id,
          evaluation_set_id: cell.evaluation_set_id,
          evaluation_set_version: cell.evaluation_set_version,
          pack_content_hash: cell.pack.content_hash,
          source_commit_sha: cell.source_commit_sha,
          execution_namespace: "cell-ns",
          target_id: cell.target_id,
          trial: cell.trial,
          effort: cell.harness.effort,
          requested_model: cell.harness.model,
          started_at: "2026-07-21T00:00:00.000Z",
          completed_at: "2026-07-21T00:00:01.000Z",
          status: "completed",
          error: null,
          task_results: [],
          artifacts: {
            base_dir: runtimeArtifacts,
            results: "results.json",
            trace: "trace.json",
            transcript: "transcript.jsonl",
            invoke_metadata: "invoke.json",
          },
        });
      },
    });
    expect(execution.cleanup.status).toBe("unconfirmed");
    expect(execution.cleanup.errors).toContain("cleanup evidence deleted set does not exactly match the immutable cleanup plan");
  });
});
