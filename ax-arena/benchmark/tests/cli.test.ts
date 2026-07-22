import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BENCHMARK_USAGE, runArenaCli, type CliIo } from "../src/cli.js";

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

describe("ax-arena benchmark CLI scaffold", () => {
  it("prints benchmark help", async () => {
    const output = capture();
    await expect(runArenaCli(["benchmark", "--help"], output.io)).resolves.toBe(0);
    expect(output.stdout).toEqual([BENCHMARK_USAGE]);
    expect(output.stdout[0]).toContain("synthesize-suite");
    expect(output.stderr).toEqual([]);
  });

  it("prints focused authoring command help", async () => {
    const output = capture();
    await expect(runArenaCli(["benchmark", "synthesize-suite", "--help"], output.io)).resolves.toBe(0);
    expect(output.stdout[0]).toContain("usage: ax-arena benchmark synthesize-suite");
    expect(output.stdout[0]).toContain("--benchmark-root <dir>");
  });

  it("rejects unknown top-level command groups and benchmark commands", async () => {
    const output = capture();
    await expect(runArenaCli(["other"], output.io)).resolves.toBe(1);
    expect(output.stderr[0]).toContain("unknown ax-arena command");

    const benchmark = capture();
    await expect(runArenaCli(["benchmark", "not-a-command"], benchmark.io)).resolves.toBe(1);
    expect(benchmark.stderr[0]).toContain("unknown benchmark command");
  });

  it("plans an immutable batch from an explicit configuration", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-runtime-plan-"));
    const configurationPath = resolve(root, "configuration.json");
    const runRoot = resolve(root, "run");
    writeFileSync(configurationPath, JSON.stringify({
      command: "daeb-low-pass",
      suite: { name: "DAEB-1", version: 1, file_hash: "1".repeat(64) },
      packs: [{
        vendor: "neon", file_hash: "2".repeat(64), standard_set_version: "database-v1", surfaces: ["api"],
        host_credential_names: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"], verification_credential_names: [], reset_credential_names: [], sandbox_scope_names: [],
      }],
      cells: [
        {
          key: "neon/api/codex/trial-1", vendor: "neon", surface: "api", harness: "codex",
          profile: "medium", effort: "medium", model: "model-codex", trial: 1,
          host_credential_names: ["OPENAI_API_KEY"], verification_credential_names: [], reset_credential_names: [], sandbox_scope_names: [],
          provider_pins: [], reset_provider: { id: "reset", version: "1.0.0" },
        },
        {
          key: "neon/api/claude-code/trial-1", vendor: "neon", surface: "api", harness: "claude-code",
          profile: "medium", effort: "medium", model: "model-claude", trial: 1,
          host_credential_names: ["ANTHROPIC_API_KEY"], verification_credential_names: [], reset_credential_names: [], sandbox_scope_names: [],
          provider_pins: [], reset_provider: { id: "reset", version: "1.0.0" },
        },
      ],
      harnesses: [
        { harness: "codex", version_raw: "codex 1.2.3", version_semver: "1.2.3" },
        { harness: "claude-code", version_raw: "claude-code 1.2.3", version_semver: "1.2.3" },
      ],
      reset_required: true,
      invoke_timeout_seconds: 900,
      first_action_timeout_seconds: 180,
      invoke_retries: 0,
    }));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init");
    git("config", "user.name", "Arena Test");
    git("config", "user.email", "arena@example.invalid");
    writeFileSync(resolve(root, "package.json"), "{}\n");
    git("add", ".");
    git("-c", "commit.gpgSign=false", "commit", "-m", "fixture");
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const mismatch = capture();
    await expect(runArenaCli([
      "benchmark", "plan",
      "--configuration", configurationPath,
      "--run-root", resolve(root, "bad-run"),
      "--source-sha", "b".repeat(40),
    ], mismatch.io, root)).resolves.toBe(1);
    expect(mismatch.stderr[0]).toContain("does not match checked-out HEAD");
    expect(existsSync(resolve(root, "bad-run"))).toBe(false);
    const output = capture();
    await expect(runArenaCli([
      "benchmark", "plan",
      "--configuration", configurationPath,
      "--run-root", runRoot,
      "--source-sha", sourceSha,
    ], output.io, root)).resolves.toBe(0);
    expect(existsSync(resolve(runRoot, "batch.json"))).toBe(true);
    expect(JSON.parse(readFileSync(resolve(runRoot, "batch.json"), "utf8")).source_commit_sha).toBe(sourceSha);
    const extraPack = capture();
    await expect(runArenaCli([
      "benchmark", "aggregate",
      "--run-root", runRoot,
      "--pack", `neon=${configurationPath}`,
      "--pack", `typo=${configurationPath}`,
      "--generated-at", "2026-07-21T00:00:00.000Z",
    ], extraPack.io, root)).resolves.toBe(1);
    expect(extraPack.stderr[0]).toContain("--pack vendors must exactly match the batch");
  });

  it("exposes runtime help and fails execution closed", async () => {
    const help = capture();
    await expect(runArenaCli(["benchmark", "aggregate", "--help"], help.io)).resolves.toBe(0);
    expect(help.stdout[0]).toContain("--pack <vendor=pack.yaml>");

    const execute = capture();
    await expect(runArenaCli(["benchmark", "execute", "--run-root", "run"], execute.io)).resolves.toBe(1);
    expect(execute.stderr[0]).toContain("trusted workflow OS sandbox");
  });

  it("runs the deterministic extract audit offline against an explicit empty root", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-authoring-cli-"));
    const output = capture();
    try {
      await expect(runArenaCli([
        "benchmark",
        "audit-extracts",
        "--benchmark-root",
        root,
      ], output.io)).resolves.toBe(0);
      expect(output.stderr).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
