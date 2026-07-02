import type { SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TargetPackSchema, type TargetPack } from "../src/schemas.js";
import {
  DEFAULT_ASYNC_SPAWN,
  defaultInvokePaths,
  detectInvokeHarness,
  runInvokeHarness,
  type AsyncSpawn,
  type InvokeRunOptions,
  type ProcResult,
} from "../src/harness/invoke.js";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ax-invoke-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pack(): TargetPack {
  return TargetPackSchema.parse({
    name: "demo",
    standard_set_version: "demo-v1",
    run_id: "gen",
    base_url: "https://api.demo.test",
    tasks: [
      {
        id: "t1",
        prompt: "Create one thing.",
        oracles: [{ type: "roundtrip", readPathTemplate: "/things/{gid}", assertField: "name", expected: "x" }],
      },
    ],
  });
}

type SyncProcResult = SpawnSyncReturns<Buffer> & ProcResult;

function spawnResult(overrides: Partial<SyncProcResult> = {}): SyncProcResult {
  return { ...makeSpawnResult(), ...overrides };
}

function makeSpawnResult(): SyncProcResult {
  return {
    pid: 123,
    output: [],
    stdout: Buffer.from("ok"),
    stderr: Buffer.from(""),
    status: 0,
    signal: null,
    error: undefined,
  };
}

function opts(dir: string, harness: "claude-code" | "codex" = "claude-code"): InvokeRunOptions {
  const paths = defaultInvokePaths(dir, `${harness}-ceiling-api`, harness);
  writeFileSync(paths.promptPath, "Do the task and write files.");
  return {
    pack: pack(),
    harness,
    profile: "ceiling",
    surface: "api",
    ns: "gen-ceiling-abcd",
    paths,
    cwd: dir,
  };
}

describe("detectInvokeHarness", () => {
  it("reports a missing local harness without throwing", () => {
    const detected = detectInvokeHarness("claude-code", () => spawnResult({
      status: null,
      stdout: Buffer.from(""),
      error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
    }));
    expect(detected.ok).toBe(false);
    expect(detected.reason).toBe("missing-harness");
    expect(detected.command).toBe("claude");
  });

  it("captures a version string when the harness is available", () => {
    const detected = detectInvokeHarness("codex", () => spawnResult({ stdout: Buffer.from("codex 1.2.3\n") }));
    expect(detected.ok).toBe(true);
    expect(detected.version).toBe("codex 1.2.3");
  });

  it("cleans up the temporary Claude HOME after detection", () => {
    let seenHome = "";
    const detected = detectInvokeHarness("claude-code", (_command, _args, options) => {
      seenHome = String(options?.env?.HOME ?? "");
      expect(existsSync(seenHome)).toBe(true);
      return spawnResult({ stdout: Buffer.from("claude 1.0.0\n") });
    });
    expect(detected.ok).toBe(true);
    expect(seenHome).not.toBe("");
    expect(existsSync(seenHome)).toBe(false);
  });
});

describe("runInvokeHarness", () => {
  it("runs a prompt, stores subprocess artifacts, and stamps the executor result with the harness id", async () => {
    const dir = freshDir();
    const run = opts(dir, "claude-code");
    // Async spawn mock — (command, args, cwd) => Promise<ProcResult>.
    const spawn = async (command: string, args: string[]) => {
      expect(command).toBe("claude");
      expect(args[0]).toBe("-p");
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({
          profile: "ceiling",
          ns: run.ns,
          surface: "api",
          discovery: {},
          results: { t1: { gid: "gid-1" } },
        }),
      );
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from('{"summary":"done"}') });
    };

    const result = await runInvokeHarness(run, spawn);
    expect(result.ok).toBe(true);
    expect(readFileSync(run.paths.stdoutPath, "utf8")).toContain("done");
    expect(readFileSync(run.paths.transcriptPath, "utf8")).toContain("done");
    const executor = JSON.parse(readFileSync(run.paths.resultsPath, "utf8"));
    expect(executor.harness).toBe("claude-code");
    expect(executor.profile).toBe("ceiling");
  });

  it("writes explainable failure artifacts when the harness exits before writing results", async () => {
    const dir = freshDir();
    const run = opts(dir, "codex");
    const result = await runInvokeHarness(
      run,
      async () => spawnResult({ status: 1, stdout: Buffer.from(""), stderr: Buffer.from("boom") }),
    );

    expect(result.ok).toBe(false);
    expect(existsSync(run.paths.resultsPath)).toBe(true);
    expect(existsSync(run.paths.tracePath)).toBe(true);
    expect(existsSync(run.paths.codexSchemaPath!)).toBe(true);
    const executor = JSON.parse(readFileSync(run.paths.resultsPath, "utf8"));
    expect(executor.harness).toBe("codex");
    expect(executor.profile).toBe("ceiling");
    expect(executor.results.t1.gid).toBeNull();
    expect(readFileSync(run.paths.stderrPath, "utf8")).toContain("boom");
  });

  it("invokes codex exec with config-based approval disabled for non-interactive runs", async () => {
    const dir = freshDir();
    const run = opts(dir, "codex");
    let seenArgs: string[] = [];
    const spawn: AsyncSpawn = async (_command, args) => {
      seenArgs = args;
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({ profile: "ceiling", ns: run.ns, surface: "api", discovery: {}, results: { t1: { gid: "g" } } }),
      );
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from('{"ok":true}') });
    };

    const result = await runInvokeHarness(run, spawn);
    expect(result.ok).toBe(true);
    expect(seenArgs).toContain("-c");
    expect(seenArgs).toContain('approval_policy="never"');
  });

  it("restricts the codex output schema to tasks that apply to the selected surface", async () => {
    const dir = freshDir();
    const surfacePack = TargetPackSchema.parse({
      ...pack(),
      tasks: [
        {
          id: "api-only",
          prompt: "Create one thing.",
          allowed_surfaces: ["api", "docs"],
          oracles: [{ type: "roundtrip", readPathTemplate: "/things/{gid}", assertField: "name", expected: "x" }],
        },
        {
          id: "mcp-only",
          prompt: "Create one thing through MCP.",
          allowed_surfaces: ["mcp", "docs"],
          oracles: [{ type: "roundtrip", readPathTemplate: "/things/{gid}", assertField: "name", expected: "y" }],
        },
      ],
    });
    const paths = defaultInvokePaths(dir, "codex-mcp", "codex");
    writeFileSync(paths.promptPath, "Do the task and write files.");
    const run: InvokeRunOptions = {
      pack: surfacePack,
      harness: "codex",
      profile: "ceiling",
      surface: "mcp",
      ns: "demo-high-mcp",
      paths,
      cwd: dir,
    };

    const spawn: AsyncSpawn = async () => {
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({ profile: "ceiling", ns: run.ns, surface: "mcp", discovery: {}, results: { "mcp-only": { gid: "g" } } }),
      );
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from('{"ok":true}') });
    };

    const result = await runInvokeHarness(run, spawn);
    expect(result.ok).toBe(true);
    const schema = JSON.parse(readFileSync(paths.codexSchemaPath!, "utf8"));
    expect(Object.keys(schema.properties.results.properties)).toEqual(["mcp-only"]);
  });

  it("includes extra per-task context ids in the codex output schema when verification needs them", async () => {
    const dir = freshDir();
    const schemaPack = TargetPackSchema.parse({
      ...pack(),
      tasks: [
        {
          id: "page-task",
          prompt: "Create a page.",
          allowed_surfaces: ["mcp", "docs"],
          create_path: "/docs/{docId}/pages",
          oracles: [{ type: "roundtrip", readPathTemplate: "/docs/{docId}/pages/{gid}", assertField: "name", expected: "x" }],
        },
      ],
    });
    const paths = defaultInvokePaths(dir, "codex-mcp-extra", "codex");
    writeFileSync(paths.promptPath, "Do the task and write files.");
    const run: InvokeRunOptions = {
      pack: schemaPack,
      harness: "codex",
      profile: "ceiling",
      surface: "mcp",
      ns: "demo-high-mcp",
      paths,
      cwd: dir,
    };

    const spawn: AsyncSpawn = async () => {
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({ profile: "ceiling", ns: run.ns, surface: "mcp", discovery: {}, results: { "page-task": { gid: "g", docId: "d" } } }),
      );
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from('{"ok":true}') });
    };

    const result = await runInvokeHarness(run, spawn);
    expect(result.ok).toBe(true);
    const schema = JSON.parse(readFileSync(paths.codexSchemaPath!, "utf8"));
    expect(schema.properties.results.properties["page-task"].required).toEqual(["gid", "docId"]);
    expect(schema.properties.results.properties["page-task"].properties.docId).toBeTruthy();
  });

  it("retries a failed invocation once, then succeeds on the second attempt", async () => {
    const dir = freshDir();
    const run = opts(dir, "claude-code");
    let calls = 0;
    const spawn: AsyncSpawn = async () => {
      calls += 1;
      if (calls === 1) {
        // First attempt crashes without writing a results file.
        return spawnResult({ status: 1, stdout: Buffer.from(""), stderr: Buffer.from("transient") });
      }
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({ profile: "ceiling", ns: run.ns, surface: "api", discovery: {}, results: { t1: { gid: "g" } } }),
      );
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from('{"ok":true}') });
    };
    const result = await runInvokeHarness({ ...run, retries: 1 }, spawn);
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("passes the timeout cap to the spawn and records a timeout as a failure", async () => {
    const dir = freshDir();
    const run = opts(dir, "codex");
    let seenTimeout: number | undefined;
    const spawn: AsyncSpawn = async (_command, _args, _cwd, spawnOpts) => {
      seenTimeout = spawnOpts?.timeoutMs;
      // Simulate the child being killed by the wall-clock cap (no results written).
      return spawnResult({ status: null, signal: "SIGTERM", timedOut: true, stdout: Buffer.from("") });
    };
    const result = await runInvokeHarness({ ...run, timeoutMs: 1000, retries: 0 }, spawn);
    expect(seenTimeout).toBe(1000);
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    const executor = JSON.parse(readFileSync(run.paths.resultsPath, "utf8"));
    expect(String(executor.discovery?.notes ?? "")).toMatch(/timed out/i);
  });

  it("cleans up the temporary Claude HOME after an invoked run", async () => {
    const dir = freshDir();
    const run = opts(dir, "claude-code");
    let seenHome = "";
    const spawn: AsyncSpawn = async (_command, _args, _cwd, spawnOpts) => {
      seenHome = String(spawnOpts?.env?.HOME ?? "");
      expect(existsSync(seenHome)).toBe(true);
      writeFileSync(
        run.paths.resultsPath,
        JSON.stringify({ profile: "ceiling", ns: run.ns, surface: "api", discovery: {}, results: { t1: { gid: "g" } } }),
      );
      writeFileSync(run.paths.tracePath, "[]");
      return spawnResult({ stdout: Buffer.from('{"ok":true}') });
    };
    const result = await runInvokeHarness(run, spawn);
    expect(result.ok).toBe(true);
    expect(seenHome).not.toBe("");
    expect(existsSync(seenHome)).toBe(false);
  });

  it("terminates a lingering wrapper once the required artifacts exist", async () => {
    const dir = freshDir();
    const resultsPath = resolve(dir, "result.json");
    const tracePath = resolve(dir, "trace.json");
    const started = Date.now();
    const result = await DEFAULT_ASYNC_SPAWN(
      "/bin/sh",
      [
        "-c",
        `node -e "const fs=require('fs'); fs.writeFileSync(${JSON.stringify(resultsPath)}, '{}'); fs.writeFileSync(${JSON.stringify(tracePath)}, '[]'); setTimeout(() => {}, 30000)" & wait`,
      ],
      dir,
      { timeoutMs: 60000, successPaths: [resultsPath, tracePath] },
    );

    expect(result.status).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it("recovers a Claude-written result file from the transcript and treats a completed run as successful", async () => {
    const dir = freshDir();
    const run = opts(dir, "claude-code");
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Write",
              input: {
                file_path: resolve(dir, run.paths.resultsPath),
                content: JSON.stringify({
                  profile: "ceiling",
                  ns: run.ns,
                  surface: "api",
                  discovery: { notes: "recovered" },
                  results: { t1: { gid: "gid-recovered" } },
                }),
              },
            },
            {
              type: "tool_use",
              name: "Write",
              input: {
                file_path: resolve(dir, run.paths.tracePath),
                content: JSON.stringify([{ step: 1, taskId: "t1", action: "create thing" }]),
              },
            },
          ],
        },
      }),
      JSON.stringify({ type: "result", subtype: "success", terminal_reason: "completed" }),
    ].join("\n");

    const result = await runInvokeHarness(
      { ...run, timeoutMs: 1000, retries: 0 },
      async () => spawnResult({ status: null, signal: "SIGTERM", timedOut: true, stdout: Buffer.from(transcript) }),
    );

    expect(result.ok).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(JSON.parse(readFileSync(run.paths.resultsPath, "utf8")).results.t1.gid).toBe("gid-recovered");
    expect(JSON.parse(readFileSync(run.paths.tracePath, "utf8"))[0].action).toBe("create thing");
  });

  it("recovers a Codex agent-message result when the file is missing", async () => {
    const dir = freshDir();
    const run = opts(dir, "codex");
    const payload = {
      profile: "ceiling",
      ns: run.ns,
      surface: "api",
      discovery: { notes: "codex recovered" },
      results: { t1: { gid: "gid-codex" } },
    };
    const stdout = [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify(payload),
        },
      }),
    ].join("\n");

    const result = await runInvokeHarness(
      run,
      async () => spawnResult({ status: 0, stdout: Buffer.from(stdout) }),
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(run.paths.resultsPath, "utf8")).results.t1.gid).toBe("gid-codex");
  });
});
