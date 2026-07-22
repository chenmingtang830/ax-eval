import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { packFileContentHash, writeApproval } from "../src/generate/review.js";
import type { InvokeRunOptions } from "../src/harness/invoke.js";
import type { TargetPack } from "../src/schemas.js";
import { TargetPackSchema } from "../src/schemas.js";
import { createRuntimeExtensionRegistry } from "../src/runtime/extensions.js";
import {
  runCellWithRuntime,
  type CellRuntimeDependencies,
} from "../src/cell/run.js";
import type { EvaluationCell } from "../src/cell/schema.js";

function fixture(): { dir: string; pack: TargetPack; cell: EvaluationCell } {
  const dir = mkdtempSync(resolve(tmpdir(), "ax-eval-cell-"));
  const packPath = resolve(dir, "pack.yaml");
  const pack = TargetPackSchema.parse({
    name: "example",
    version: "1",
    standard_set_version: "example-v1",
    run_id: "example-run",
    generated_by: "deterministic@no-model",
    auth_method: "none",
    auth: { type: "none" },
    base_url: "https://example.invalid",
    site_url: "",
    docs_urls: [],
    tasks: [{
      id: "task-1",
      title: "Create an example",
      prompt: "Create an example named AX probe {ns}",
      difficulty: "L1",
      allowed_surfaces: ["api"],
      oracles: [{
        type: "roundtrip",
        readPathTemplate: "/examples/{gid}",
        assertField: "name",
        expected: "AX probe {ns}",
        description: "",
      }],
    }],
  });
  writeFileSync(packPath, yamlStringify(pack));
  writeApproval(packPath, pack, "cell-test");
  return {
    dir,
    pack,
    cell: {
      schema: "ax.evaluation-cell/v1",
      cell_id: "batch-1-example-api-codex-t2",
      batch_id: "batch-1",
      evaluation_set_id: "example-set",
      evaluation_set_version: pack.standard_set_version,
      target_id: "example",
      pack: { path: "pack.yaml", content_hash: packFileContentHash(packPath) },
      surface: "api",
      harness: { id: "codex", profile: "medium", model: "gpt-example", effort: "high" },
      trial: 2,
      source_commit_sha: "a".repeat(40),
      required_credentials: [],
      run_context: {
        cwd: dir,
        artifact_dir: "artifacts",
        invoke_timeout_ms: 12_000,
        first_action_timeout_ms: 3_000,
        invoke_retries: 0,
      },
    },
  };
}

function runtime(
  invokeOptions: InvokeRunOptions[],
  invokeOk = true,
): CellRuntimeDependencies {
  let tick = 0;
  return {
    now: () => new Date(`2026-07-21T00:00:0${tick++}.000Z`),
    detectHarness: () => ({ ok: true, command: "codex", version: "codex-cli 1.2.3" }),
    provisionHarness: async () => ({ env: { CELL_ONLY: "yes" }, meta: { kind: "fake" } }),
    invokeHarness: async (options) => {
      invokeOptions.push(options);
      writeFileSync(options.paths.resultsPath, JSON.stringify({
        profile: options.profile,
        harness: options.harness,
        model: options.model,
        ns: options.ns,
        surface: options.surface,
        results: { "task-1": { gid: "example-1" } },
      }));
      writeFileSync(options.paths.tracePath, JSON.stringify([
        { step: 1, taskId: "task-1", action: "POST", method: "POST", path: "/examples" },
      ]));
      writeFileSync(options.paths.transcriptPath, "");
      writeFileSync(options.paths.metaPath, "{}");
      return {
        harness: options.harness,
        ok: invokeOk,
        exitCode: invokeOk ? 0 : 1,
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
        error: invokeOk ? undefined : "fake invoke failed",
        attempts: 1,
        durationMs: 25,
        validity_status: invokeOk ? "valid" : "invoke_failed",
        first_action_latency_ms: 4,
        transcript_event_count: 1,
        action_occurred: true,
        metrics: {
          harness_version_raw: "codex-cli 1.2.3",
          harness_version_semver: "1.2.3",
          run_batch_id: options.runBatchId ?? null,
          duration_ms: 25,
          total_duration_ms: 25,
          cost_usd: null,
          token_usage: { input_tokens: 10, output_tokens: 5 },
          num_turns: 1,
        },
      };
    },
    verificationClient: () => ({} as never),
    verify: async (_pack, executor) => [{
      taskId: "task-1",
      difficulty: "L1",
      profile: executor.profile,
      success: true,
      oracleResults: [{ type: "roundtrip", passed: true, detail: "name matched" }],
      error: null,
      na: false,
    }],
  };
}

describe("runCell", () => {
  it("runs exactly one explicit cell and stamps comparable identity", async () => {
    const { cell } = fixture();
    const invokes: InvokeRunOptions[] = [];
    const record = await runCellWithRuntime(cell, { credentials: {} }, runtime(invokes));

    expect(invokes).toHaveLength(1);
    expect(invokes[0]).toMatchObject({
      harness: "codex",
      surface: "api",
      model: "gpt-example",
      effort: "high",
      retries: 0,
      runBatchId: "batch-1",
      replaceEnv: true,
      requireTrace: true,
    });
    expect(invokes[0]!.ns).toContain("batch-1-batch-1-example-api-codex-t2-gpt-example");
    expect(record).toMatchObject({
      schema: "ax.normalized-cell-record/v1",
      record_id: cell.cell_id,
      cell_id: cell.cell_id,
      batch_id: "batch-1",
      run_batch_id: "batch-1",
      evaluation_set_id: "example-set",
      evaluation_set_version: "example-v1",
      standard_set_version: "example-v1",
      pack_content_hash: cell.pack.content_hash,
      source_commit_sha: cell.source_commit_sha,
      target_id: "example",
      product: "example",
      harness: "codex",
      model: "gpt-example",
      requested_model: "gpt-example",
      effort: "high",
      trial: 2,
      status: "completed",
      tasks_total: 1,
      tasks_passed: 1,
      pass_at_1: 1,
      summary_kind: "single",
      error: null,
    });
    expect(record.task_results[0]?.oracleResults[0]?.detail).toBe("name matched");
    expect(record).not.toHaveProperty("provider_provenance");
  });

  it("runs health and additive provisioning extensions before invoke and records selected provenance", async () => {
    const { cell } = fixture();
    const events: string[] = [];
    const resetPlan = vi.fn();
    const resetExecute = vi.fn();
    const registry = createRuntimeExtensionRegistry({
      oracleProviders: [{
        id: "roundtrip-provider",
        version: "1.2.0",
        matches: () => true,
        async verify(oracle) {
          return { type: oracle.type, passed: true, detail: "extension verified" };
        },
      }],
      resetProviders: [{
        id: "cleanup-provider",
        version: "4.0.0",
        matches: () => true,
        plan: resetPlan,
        execute: resetExecute,
      }],
      healthCheckProviders: [{
        id: "health-provider",
        version: "2.0.0",
        matches: () => true,
        async check() {
          events.push("health");
          return [{ status: "pass", message: "ready" }];
        },
      }],
      provisioningProviders: [{
        id: "tool-provider",
        version: "3.1.0",
        matches: () => true,
        async inspect() {
          events.push("inspect");
          return { ready: true };
        },
        async provision() {
          events.push("extension-provision");
          return { env: { EXTENSION_ONLY: "yes" }, metadata: { tool_version: "3.1.0" } };
        },
      }],
    });
    const invokes: InvokeRunOptions[] = [];
    const isolated = runtime(invokes);
    const provisionHarness = isolated.provisionHarness;
    isolated.provisionHarness = async (...args) => {
      events.push("core-provision");
      return provisionHarness(...args);
    };
    const invokeHarness = isolated.invokeHarness;
    isolated.invokeHarness = async (...args) => {
      events.push("invoke");
      return invokeHarness(...args);
    };
    const verify = isolated.verify;
    isolated.verify = async (...args) => {
      events.push("verify");
      return verify(...args);
    };

    const record = await runCellWithRuntime(
      cell,
      { credentials: {}, extensions: { registry } },
      isolated,
    );

    expect(events).toEqual(["health", "inspect", "extension-provision", "core-provision", "invoke", "verify"]);
    expect(invokes[0]!.env).toMatchObject({ CELL_ONLY: "yes", EXTENSION_ONLY: "yes" });
    expect(invokes[0]!.provisioning).toMatchObject({
      extension_provider: { id: "tool-provider", version: "3.1.0" },
      extension_metadata: { tool_version: "3.1.0" },
    });
    expect(record.provider_provenance).toEqual([
      { kind: "health-check", id: "health-provider", version: "2.0.0" },
      { kind: "oracle", id: "roundtrip-provider", version: "1.2.0" },
      { kind: "provisioning", id: "tool-provider", version: "3.1.0" },
    ]);
    expect(resetPlan).not.toHaveBeenCalled();
    expect(resetExecute).not.toHaveBeenCalled();
  });

  it("blocks on a failed health extension before provisioning or invocation", async () => {
    const { cell } = fixture();
    const isolated = runtime([]);
    isolated.provisionHarness = vi.fn();
    isolated.invokeHarness = vi.fn();
    const registry = createRuntimeExtensionRegistry({
      healthCheckProviders: [{
        id: "health-provider",
        version: "1.0.0",
        matches: () => true,
        async check() {
          return [{ status: "fail", message: "credential scope is inconsistent" }];
        },
      }],
    });

    const record = await runCellWithRuntime(cell, { credentials: {}, extensions: { registry } }, isolated);
    expect(record).toMatchObject({
      status: "blocked",
      blocked: "health-check-failed",
      error: { stage: "preflight" },
    });
    expect(record.error?.message).toContain("credential scope is inconsistent");
    expect(isolated.provisionHarness).not.toHaveBeenCalled();
    expect(isolated.invokeHarness).not.toHaveBeenCalled();
  });

  it("normalizes extension matcher failures without leaking their message", async () => {
    const { cell } = fixture();
    const isolated = runtime([]);
    isolated.invokeHarness = vi.fn();
    const registry = createRuntimeExtensionRegistry({
      healthCheckProviders: [{
        id: "broken-matcher",
        version: "1.0.0",
        matches() {
          throw new Error("opaque-matcher-secret");
        },
        async check() {
          return [];
        },
      }],
    });

    const record = await runCellWithRuntime(cell, { credentials: {}, extensions: { registry } }, isolated);
    expect(record).toMatchObject({ status: "blocked", error: { stage: "preflight" } });
    expect(record.error?.message).toBe('health-check provider "broken-matcher" match failed');
    expect(JSON.stringify(record)).not.toContain("opaque-matcher-secret");
    expect(isolated.invokeHarness).not.toHaveBeenCalled();
  });

  it("rejects provisioning environment replacement before invocation", async () => {
    const { cell } = fixture();
    const isolated = runtime([]);
    isolated.invokeHarness = vi.fn();
    const registry = createRuntimeExtensionRegistry({
      provisioningProviders: [{
        id: "unsafe-provider",
        version: "1.0.0",
        matches: () => true,
        async inspect() {
          return { ready: true };
        },
        async provision() {
          return { env: { CELL_ONLY: "replacement" } };
        },
      }],
    });

    const record = await runCellWithRuntime(cell, { credentials: {}, extensions: { registry } }, isolated);
    expect(record).toMatchObject({ status: "blocked", error: { stage: "provision" } });
    expect(record.error?.message).toContain("attempted to replace environment key(s): CELL_ONLY");
    expect(isolated.invokeHarness).not.toHaveBeenCalled();
  });

  it("reserves core environment names even when the parent omitted them", async () => {
    const { cell } = fixture();
    const isolated = runtime([]);
    isolated.invokeHarness = vi.fn();
    vi.stubEnv("PATH", "");
    const registry = createRuntimeExtensionRegistry({
      provisioningProviders: [{
        id: "path-provider",
        version: "1.0.0",
        matches: () => true,
        async inspect() {
          return { ready: true };
        },
        async provision() {
          return { env: { PATH: "/tmp/untrusted-bin" } };
        },
      }],
    });

    try {
      const record = await runCellWithRuntime(cell, { credentials: {}, extensions: { registry } }, isolated);
      expect(record.error?.message).toContain("attempted to replace environment key(s): PATH");
      expect(isolated.invokeHarness).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never exposes verifier-only credentials to provisioning or its harness environment", async () => {
    const { cell, dir, pack } = fixture();
    pack.auth_method = "pat";
    pack.auth = {
      type: "bearer",
      env: "AGENT_TOKEN",
      env_aliases: [],
      verify_env: "VERIFY_TOKEN",
      verify_env_aliases: [],
    };
    const packPath = resolve(dir, "pack.yaml");
    writeFileSync(packPath, yamlStringify(pack));
    writeApproval(packPath, pack, "cell-test");
    cell.pack.content_hash = packFileContentHash(packPath);
    cell.required_credentials = ["AGENT_TOKEN", "VERIFY_TOKEN"];
    const isolated = runtime([]);
    isolated.invokeHarness = vi.fn();
    const registry = createRuntimeExtensionRegistry({
      provisioningProviders: [{
        id: "credential-probe",
        version: "1.0.0",
        matches: () => true,
        async inspect() {
          return { ready: true };
        },
        async provision(context) {
          expect(context.credentials).toEqual({ AGENT_TOKEN: "agent-secret" });
          return { env: { VERIFY_TOKEN: "attempted-leak" } };
        },
      }],
    });

    const record = await runCellWithRuntime(
      cell,
      {
        credentials: { AGENT_TOKEN: "agent-secret", VERIFY_TOKEN: "verify-secret" },
        extensions: { registry },
      },
      isolated,
    );
    expect(record).toMatchObject({ status: "blocked", error: { stage: "provision" } });
    expect(record.error?.message).toContain("attempted to replace environment key(s): VERIFY_TOKEN");
    expect(record.error?.message).not.toContain("verify-secret");
    expect(isolated.invokeHarness).not.toHaveBeenCalled();
  });

  it("keeps controller-only verification credentials out of the harness child", async () => {
    const { cell } = fixture();
    cell.required_credentials = ["AGENT_TOKEN"];
    const isolated = runtime([]);
    const invoke = isolated.invokeHarness;
    isolated.invokeHarness = async (options) => {
      expect(options.env.AGENT_TOKEN).toBe("agent-secret");
      expect(options.env.DATABASE_URL).toBeUndefined();
      return invoke(options);
    };
    const verify = isolated.verify;
    isolated.verify = async (...args) => {
      expect(args[7]).toEqual({ DATABASE_URL: "private-database-secret" });
      return verify(...args);
    };

    const record = await runCellWithRuntime(cell, {
      credentials: { AGENT_TOKEN: "agent-secret", DATABASE_URL: "must-not-leak" },
      verificationCredentials: { DATABASE_URL: "private-database-secret" },
    }, isolated);
    expect(record.status).toBe("completed");
  });

  it("blocks before invocation when an explicit verifier credential map is incomplete", async () => {
    const { cell, dir, pack } = fixture();
    pack.auth_method = "pat";
    pack.auth = {
      type: "bearer",
      env: "AGENT_TOKEN",
      env_aliases: [],
      verify_env: "VERIFY_TOKEN",
      verify_env_aliases: [],
    };
    const packPath = resolve(dir, "pack.yaml");
    writeFileSync(packPath, yamlStringify(pack));
    writeApproval(packPath, pack, "cell-test");
    cell.pack.content_hash = packFileContentHash(packPath);
    cell.required_credentials = ["AGENT_TOKEN"];
    const isolated = runtime([]);
    isolated.invokeHarness = vi.fn();

    const record = await runCellWithRuntime(cell, {
      credentials: { AGENT_TOKEN: "agent-secret" },
      verificationCredentials: {},
    }, isolated);

    expect(record).toMatchObject({
      status: "blocked",
      blocked: "missing-credential",
      error: { stage: "preflight" },
    });
    expect(record.error?.message).toContain("VERIFY_TOKEN");
    expect(isolated.invokeHarness).not.toHaveBeenCalled();
  });

  it("returns a schema-valid failed record when invocation fails", async () => {
    const { cell } = fixture();
    const record = await runCellWithRuntime(cell, { credentials: {} }, runtime([], false));
    expect(record.status).toBe("failed");
    expect(record.error).toEqual({ stage: "invoke", message: "fake invoke failed" });
    expect(record.task_results).toHaveLength(1);
  });

  it("rejects a stale cell hash before invoking", async () => {
    const { cell } = fixture();
    const invokeHarness = vi.fn();
    await expect(runCellWithRuntime(
      { ...cell, pack: { ...cell.pack, content_hash: "0".repeat(64) } },
      { credentials: {} },
      { ...runtime([]), invokeHarness },
    )).rejects.toThrow(/content hash mismatch/);
    expect(invokeHarness).not.toHaveBeenCalled();
  });

  it("returns a blocked record before invoking when a declared credential is missing", async () => {
    const { cell } = fixture();
    const invokeHarness = vi.fn();
    const record = await runCellWithRuntime(
      { ...cell, required_credentials: ["EXAMPLE_TOKEN"] },
      { credentials: {} },
      { ...runtime([]), invokeHarness },
    );
    expect(record).toMatchObject({ status: "blocked", blocked: "missing-credential" });
    expect(record.error?.message).toContain("EXAMPLE_TOKEN");
    expect(invokeHarness).not.toHaveBeenCalled();
  });

  it("redacts supplied credential values from lifecycle failures", async () => {
    const { cell } = fixture();
    const failing = runtime([]);
    failing.provisionHarness = async () => {
      throw new Error("provider rejected secret-value");
    };
    const record = await runCellWithRuntime(
      { ...cell, required_credentials: ["EXAMPLE_TOKEN"] },
      { credentials: { EXAMPLE_TOKEN: "secret-value" } },
      failing,
    );
    expect(record.status).toBe("blocked");
    expect(record.error?.message).toContain("<redacted>");
    expect(record.error?.message).not.toContain("secret-value");
  });

  it("normalizes rejected invocations into failed records", async () => {
    const { cell } = fixture();
    const failing = runtime([]);
    failing.invokeHarness = async () => {
      throw new Error("subprocess rejected");
    };
    const record = await runCellWithRuntime(cell, { credentials: {} }, failing);
    expect(record.status).toBe("failed");
    expect(record.error).toEqual({ stage: "invoke", message: "subprocess rejected" });
  });

  it("clears deterministic artifacts before retrying the same immutable cell", async () => {
    const { cell } = fixture();
    await runCellWithRuntime(cell, { credentials: {} }, runtime([]));
    const second = runtime([]);
    const invoke = second.invokeHarness;
    second.invokeHarness = async (options) => {
      expect(existsSync(options.paths.resultsPath)).toBe(false);
      expect(existsSync(options.paths.tracePath)).toBe(false);
      return invoke(options);
    };
    const record = await runCellWithRuntime(cell, { credentials: {} }, second);
    expect(record.status).toBe("completed");
  });

  it("removes dangling artifact symlinks before trusted writes", async () => {
    const { cell, dir } = fixture();
    const invokes: InvokeRunOptions[] = [];
    await runCellWithRuntime(cell, { credentials: {} }, runtime(invokes));
    const outside = resolve(dir, "outside-prompt.txt");
    rmSync(invokes[0]!.paths.promptPath);
    symlinkSync(outside, invokes[0]!.paths.promptPath);

    const record = await runCellWithRuntime(cell, { credentials: {} }, runtime([]));
    expect(record.status).toBe("completed");
    expect(existsSync(outside)).toBe(false);
  });

  it("rejects harness-created primary artifact symlinks without rewriting their targets", async () => {
    const { cell, dir } = fixture();
    const outside = resolve(dir, "outside-results.json");
    writeFileSync(outside, "outside-original");
    const isolated = runtime([]);
    const invoke = isolated.invokeHarness;
    isolated.invokeHarness = async (options) => {
      const result = await invoke(options);
      rmSync(options.paths.resultsPath);
      symlinkSync(outside, options.paths.resultsPath);
      return result;
    };

    const record = await runCellWithRuntime(cell, { credentials: {} }, isolated);
    expect(record.status).toBe("failed");
    expect(record.error?.stage).toBe("invoke");
    expect(readFileSync(outside, "utf8")).toBe("outside-original");
  });

  it("does not follow a swapped invoke-home root while normalizing invocation failure", async () => {
    const { cell, dir } = fixture();
    const homeRoot = resolve(dir, "artifacts", ".invoke-home");
    const home = resolve(homeRoot, "cell-home");
    const movedHome = resolve(dir, "moved-invoke-home");
    const outside = resolve(dir, "outside-home");
    mkdirSync(outside, { recursive: true });
    const outsideFile = resolve(outside, "credential.txt");
    writeFileSync(outsideFile, "secret-value");
    const isolated = runtime([]);
    isolated.provisionHarness = async () => {
      mkdirSync(home, { recursive: true });
      return { env: { HOME: home }, meta: { kind: "fake" } };
    };
    isolated.invokeHarness = async () => {
      renameSync(homeRoot, movedHome);
      symlinkSync(outside, homeRoot);
      throw new Error("invoke-home identity changed");
    };

    const record = await runCellWithRuntime(
      { ...cell, required_credentials: ["EXAMPLE_TOKEN"] },
      { credentials: { EXAMPLE_TOKEN: "secret-value" } },
      isolated,
    );
    expect(record.status).toBe("failed");
    expect(readFileSync(outsideFile, "utf8")).toBe("secret-value");
  });

  it("overwrites executor identity with the trusted cell namespace", async () => {
    const { cell } = fixture();
    const invokes: InvokeRunOptions[] = [];
    const isolated = runtime(invokes);
    const verify = isolated.verify;
    isolated.verify = async (...args) => {
      expect(args[1].ns).toBe(invokes[0]!.ns);
      expect(args[1]).toMatchObject({ profile: "medium", harness: "codex", surface: "api" });
      return verify(...args);
    };
    await runCellWithRuntime(cell, { credentials: {} }, isolated);
  });

  it("passes the required trace independently from the parsed transcript", async () => {
    const { cell } = fixture();
    const isolated = runtime([]);
    const verify = isolated.verify;
    isolated.verify = async (...args) => {
      expect(args[4]).toBeDefined();
      expect(args[5]).toEqual([
        { step: 1, taskId: "task-1", action: "POST", method: "POST", path: "/examples" },
      ]);
      return verify(...args);
    };
    const record = await runCellWithRuntime(cell, { credentials: {} }, isolated);
    expect(record.status).toBe("completed");
  });

  it("scrubs opaque credentials from successful artifacts and oracle details", async () => {
    const { cell } = fixture();
    const isolated = runtime([]);
    const invoke = isolated.invokeHarness;
    isolated.invokeHarness = async (options) => {
      const result = await invoke(options);
      const payload = JSON.parse(readFileSync(options.paths.resultsPath, "utf8"));
      payload.opaque = "secret-value";
      writeFileSync(options.paths.resultsPath, JSON.stringify(payload));
      writeFileSync(options.paths.tracePath, JSON.stringify([{ note: "secret-value" }]));
      return result;
    };
    isolated.verify = async (_pack, executor) => [{
      taskId: "task-1",
      difficulty: "L1",
      profile: executor.profile,
      success: true,
      oracleResults: [{ type: "roundtrip", passed: true, detail: "verified secret-value" }],
      error: null,
      na: false,
    }];
    const record = await runCellWithRuntime(
      { ...cell, required_credentials: ["EXAMPLE_TOKEN"] },
      { credentials: { EXAMPLE_TOKEN: "secret-value" } },
      isolated,
    );
    expect(record.task_results[0]!.oracleResults[0]!.detail).toBe("verified <redacted>");
    const results = readFileSync(resolve(record.artifacts.base_dir, record.artifacts.results), "utf8");
    const trace = readFileSync(resolve(record.artifacts.base_dir, record.artifacts.trace), "utf8");
    expect(`${results}\n${trace}`).not.toContain("secret-value");
  });

  it("fails closed when a short credential appears in persisted text", async () => {
    const { cell } = fixture();
    const isolated = runtime([]);
    const invoke = isolated.invokeHarness;
    isolated.invokeHarness = async (options) => {
      const result = await invoke(options);
      const payload = JSON.parse(readFileSync(options.paths.resultsPath, "utf8"));
      payload.opaque = "123";
      writeFileSync(options.paths.resultsPath, JSON.stringify(payload));
      writeFileSync(options.paths.tracePath, JSON.stringify([{ step: 1, taskId: "task-1", action: "used 123" }]));
      return result;
    };
    isolated.verify = async (_pack, executor) => [{
      taskId: "task-1",
      difficulty: "L1",
      profile: executor.profile,
      success: false,
      oracleResults: [{ type: "roundtrip", passed: false, detail: "provider returned 123" }],
      error: null,
      na: false,
    }];
    const record = await runCellWithRuntime(
      { ...cell, required_credentials: ["EXAMPLE_PIN"] },
      { credentials: { EXAMPLE_PIN: "123" } },
      isolated,
    );
    expect(JSON.stringify(record)).not.toContain("123");
    const results = readFileSync(resolve(record.artifacts.base_dir, record.artifacts.results), "utf8");
    const trace = readFileSync(resolve(record.artifacts.base_dir, record.artifacts.trace), "utf8");
    expect(`${results}\n${trace}`).not.toContain("123");
  });

  it("does not require top-level API auth for an independently authenticated CLI cell", async () => {
    const { cell, pack, dir } = fixture();
    pack.auth_method = "pat";
    pack.auth = { type: "bearer", env: "API_TOKEN", env_aliases: [], verify_env_aliases: [] };
    pack.surfaces = {
      cli: {
        bin: "example-cli",
        auth: { kind: "token", token_env: "CLI_TOKEN", token_env_aliases: [] },
      },
    };
    pack.tasks[0]!.allowed_surfaces = ["cli"];
    const packPath = resolve(dir, "pack.yaml");
    writeFileSync(packPath, yamlStringify(pack));
    writeApproval(packPath, pack, "cell-test");
    const cliCell: EvaluationCell = {
      ...cell,
      surface: "cli",
      pack: { path: "pack.yaml", content_hash: packFileContentHash(packPath) },
      required_credentials: ["CLI_TOKEN"],
    };

    const record = await runCellWithRuntime(
      cliCell,
      { credentials: { CLI_TOKEN: "cli-secret" } },
      runtime([]),
    );
    expect(record.status).toBe("completed");
  });

  it("treats every provisioning environment value as secret regardless of its key name", async () => {
    const { cell } = fixture();
    const isolated = runtime([]);
    const invoke = isolated.invokeHarness;
    isolated.invokeHarness = async (options) => {
      const result = await invoke(options);
      const payload = JSON.parse(readFileSync(options.paths.resultsPath, "utf8"));
      payload.session = "opaque-session-value";
      writeFileSync(options.paths.resultsPath, JSON.stringify(payload));
      writeFileSync(options.paths.tracePath, JSON.stringify([{ note: "opaque-session-value" }]));
      return result;
    };
    isolated.verify = async (_pack, executor) => [{
      taskId: "task-1",
      difficulty: "L1",
      profile: executor.profile,
      success: true,
      oracleResults: [{ type: "roundtrip", passed: true, detail: "verified opaque-session-value" }],
      error: null,
      na: false,
    }];
    const registry = createRuntimeExtensionRegistry({
      provisioningProviders: [{
        id: "session-provider",
        version: "1.0.0",
        matches: () => true,
        async inspect() {
          return { ready: true };
        },
        async provision() {
          return { env: { SESSION: "opaque-session-value" } };
        },
      }],
    });

    const record = await runCellWithRuntime(cell, { credentials: {}, extensions: { registry } }, isolated);
    expect(record.task_results[0]!.oracleResults[0]!.detail).toBe("verified <redacted>");
    const results = readFileSync(resolve(record.artifacts.base_dir, record.artifacts.results), "utf8");
    const trace = readFileSync(resolve(record.artifacts.base_dir, record.artifacts.trace), "utf8");
    expect(`${results}\n${trace}\n${JSON.stringify(record)}`).not.toContain("opaque-session-value");
  });

  it("rejects pack and artifact paths that escape the declared working directory", async () => {
    const { cell } = fixture();
    await expect(runCellWithRuntime(
      { ...cell, run_context: { ...cell.run_context, artifact_dir: "../escape" } },
      { credentials: {} },
      runtime([]),
    )).rejects.toThrow(/must resolve inside run_context.cwd/);
  });

  it("rejects an in-workspace artifact symlink that resolves outside", async () => {
    const { cell, dir } = fixture();
    const outside = mkdtempSync(resolve(tmpdir(), "ax-cell-outside-"));
    symlinkSync(outside, resolve(dir, "linked-artifacts"));
    await expect(runCellWithRuntime(
      { ...cell, run_context: { ...cell.run_context, artifact_dir: "linked-artifacts" } },
      { credentials: {} },
      runtime([]),
    )).rejects.toThrow(/must resolve inside run_context.cwd/);
  });

  it("rejects an invoke-home symlink before provisioning", async () => {
    const { cell, dir } = fixture();
    const outside = mkdtempSync(resolve(tmpdir(), "ax-cell-home-outside-"));
    const artifacts = resolve(dir, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    symlinkSync(outside, resolve(artifacts, ".invoke-home"));
    await expect(runCellWithRuntime(cell, { credentials: {} }, runtime([])))
      .rejects.toThrow(/\.invoke-home must be a real directory/);
  });
});
