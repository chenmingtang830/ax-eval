import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TargetPackSchema, type TargetPack } from "../src/schemas.js";
import {
  defaultInvokePaths,
  detectInvokeHarness,
  runInvokeHarness,
  type InvokeRunOptions,
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

function spawnResult(overrides: Partial<ReturnType<typeof makeSpawnResult>> = {}) {
  return { ...makeSpawnResult(), ...overrides };
}

function makeSpawnResult() {
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
});
