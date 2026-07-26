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
    const runRoot = resolve(root, "results", "run");
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
    writeFileSync(resolve(root, ".gitignore"), "results/\n");
    git("add", ".");
    git("-c", "commit.gpgSign=false", "commit", "-m", "fixture");
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    for (const protectedRoot of [
      root,
      resolve(root, ".git", "refs", "heads", "arena-batch"),
      resolve(root, ".github", "arena-batch"),
      resolve(root, "src", "arena-batch"),
    ]) {
      const protectedOutput = capture();
      await expect(runArenaCli([
        "benchmark", "plan",
        "--configuration", configurationPath,
        "--run-root", protectedRoot,
        "--source-sha", sourceSha,
      ], protectedOutput.io, root)).resolves.toBe(1);
      expect(protectedOutput.stderr[0]).toMatch(/must resolve inside|must not overlap protected source path/);
      expect(existsSync(resolve(protectedRoot, "batch.json"))).toBe(false);
    }
    const protectedAggregate = capture();
    const protectedAggregateRoot = resolve(root, ".github", "arena-aggregate");
    await expect(runArenaCli([
      "benchmark", "aggregate",
      "--run-root", protectedAggregateRoot,
      "--pack", `neon=${configurationPath}`,
    ], protectedAggregate.io, root)).resolves.toBe(1);
    expect(protectedAggregate.stderr[0]).toContain("must not overlap protected source path .github");
    expect(existsSync(protectedAggregateRoot)).toBe(false);
    const mismatch = capture();
    await expect(runArenaCli([
      "benchmark", "plan",
      "--configuration", configurationPath,
      "--run-root", resolve(root, "results", "bad-run"),
      "--source-sha", "b".repeat(40),
    ], mismatch.io, root)).resolves.toBe(1);
    expect(mismatch.stderr[0]).toContain("does not match checked-out HEAD");
    expect(existsSync(resolve(root, "results", "bad-run"))).toBe(false);
    const output = capture();
    const planCode = await runArenaCli([
      "benchmark", "plan",
      "--configuration", configurationPath,
      "--run-root", runRoot,
      "--source-sha", sourceSha,
    ], output.io, root);
    expect(output.stderr).toEqual([]);
    expect(planCode).toBe(0);
    expect(existsSync(resolve(runRoot, "batch.json"))).toBe(true);
    expect(existsSync(resolve(runRoot, "batch-plan.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(resolve(runRoot, "batch.json"), "utf8"));
    expect(manifest.source_commit_sha).toBe(sourceSha);
    expect(manifest.configuration_source).toEqual({
      path: "configuration.json",
      file_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const plan = JSON.parse(readFileSync(resolve(runRoot, "batch-plan.json"), "utf8"));
    expect(plan.schema).toBe("ax.arena-batch-plan/v1");
    expect(plan.configuration_source).toEqual(manifest.configuration_source);
    expect(plan.expected_cells).toEqual([
      "neon/api/codex/trial-1",
      "neon/api/claude-code/trial-1",
    ]);
    expect(output.stdout[0]).toContain(resolve(runRoot, "batch-plan.json"));
    expect(output.stdout[0]?.split("\n").slice(-2)).toEqual([
      manifest.configuration_source.path,
      manifest.configuration_source.file_hash,
    ]);
    const resumed = capture();
    await expect(runArenaCli([
      "benchmark", "plan",
      "--configuration", configurationPath,
      "--run-root", runRoot,
      "--source-sha", sourceSha,
    ], resumed.io, root)).resolves.toBe(0);
    expect(resumed.stdout[0]?.split("\n")[0]).toBe(output.stdout[0]?.split("\n")[0]);
    writeFileSync(configurationPath, `${readFileSync(configurationPath, "utf8")}\n`);
    const uncommitted = capture();
    await expect(runArenaCli([
      "benchmark", "plan",
      "--configuration", configurationPath,
      "--run-root", resolve(root, "results", "uncommitted-run"),
      "--source-sha", sourceSha,
    ], uncommitted.io, root)).resolves.toBe(1);
    expect(uncommitted.stderr[0]).toContain("must match the immutable source commit");
    expect(existsSync(resolve(root, "results", "uncommitted-run"))).toBe(false);
    const extraPack = capture();
    await expect(runArenaCli([
      "benchmark", "aggregate",
      "--run-root", runRoot,
      "--pack", `neon=${configurationPath}`,
      "--pack", `typo=${configurationPath}`,
      "--generated-at", "2026-07-21T00:00:00.000Z",
    ], extraPack.io, root)).resolves.toBe(1);
    expect(extraPack.stderr[0]).toContain("--pack vendors must exactly match the batch");
  }, 20_000);

  it("exposes runtime help and fails execution closed", async () => {
    const help = capture();
    await expect(runArenaCli(["benchmark", "aggregate", "--help"], help.io)).resolves.toBe(0);
    expect(help.stdout[0]).toContain("--pack <vendor=pack.yaml>");

    const exportHelp = capture();
    await expect(runArenaCli(["benchmark", "export-publication", "--help"], exportHelp.io)).resolves.toBe(0);
    expect(exportHelp.stdout[0]).toContain("--from <publication-bundle-dir>");

    const exportMissing = capture();
    await expect(runArenaCli(["benchmark", "export-publication"], exportMissing.io)).resolves.toBe(1);
    expect(exportMissing.stderr[0]).toContain("missing required flag --from");

    const exportTimestamp = capture();
    await expect(runArenaCli([
      "benchmark", "export-publication", "--from", "bundle", "--out", "out", "--generated-at", "today",
    ], exportTimestamp.io)).resolves.toBe(1);
    expect(exportTimestamp.stderr[0]).toContain("exact UTC ISO timestamp");

    const competitiveHelp = capture();
    await expect(runArenaCli(["benchmark", "competitive", "--help"], competitiveHelp.io)).resolves.toBe(0);
    expect(competitiveHelp.stdout[0]).toContain("--from <sealed-publication-bundle>");

    const bundleHelp = capture();
    await expect(runArenaCli(["benchmark", "publication-bundle", "--help"], bundleHelp.io)).resolves.toBe(0);
    expect(bundleHelp.stdout[0]).toContain("--run-root <completed-run-dir>");
    expect(bundleHelp.stdout[0]).toContain("--benchmark-root <arena-daeb-root>");

    const bundleMissing = capture();
    await expect(runArenaCli(["benchmark", "publication-bundle", "--out", "bundle"], bundleMissing.io)).resolves.toBe(1);
    expect(bundleMissing.stderr[0]).toContain("missing required flag --run-root");

    const bundleTimestamp = capture();
    await expect(runArenaCli([
      "benchmark", "publication-bundle", "--run-root", "run", "--out", "bundle", "--generated-at", "today",
    ], bundleTimestamp.io)).resolves.toBe(1);
    expect(bundleTimestamp.stderr[0]).toContain("exact UTC ISO timestamp");

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
