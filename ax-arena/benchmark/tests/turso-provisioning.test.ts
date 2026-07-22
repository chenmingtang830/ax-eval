import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvaluationCellSchema, TargetPackSchema } from "ax-eval";
import { createTursoCliProvisioningProvider } from "../src/providers/turso-provisioning.js";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ax-arena-turso-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function target(cwd: string, artifactDir: string) {
  const cell = EvaluationCellSchema.parse({
    schema: "ax.evaluation-cell/v1",
    cell_id: "cell-1",
    batch_id: "batch-1",
    evaluation_set_id: "daeb",
    evaluation_set_version: "1",
    target_id: "turso",
    pack: { path: "pack.yaml", content_hash: "0".repeat(64) },
    surface: "cli",
    harness: { id: "codex", profile: "medium", model: "test", effort: "medium" },
    trial: 1,
    source_commit_sha: "a".repeat(40),
    required_credentials: [],
    run_context: {
      cwd,
      artifact_dir: artifactDir,
      invoke_timeout_ms: 1,
      first_action_timeout_ms: 1,
      invoke_retries: 0,
    },
  });
  const pack = TargetPackSchema.parse({
    name: "turso",
    surfaces: { cli: { bin: "turso", auth: { kind: "inherit", token_env_aliases: [] } } },
    tasks: [],
  });
  return { cell, pack, cwd, artifactDir };
}

describe("Turso CLI provisioning provider", () => {
  it("attests an executable outside writable paths without downloading", async () => {
    const cwd = freshDir();
    const artifactDir = resolve(cwd, "artifacts");
    mkdirSync(artifactDir);
    const binDir = resolve(freshDir(), "bin");
    mkdirSync(binDir);
    const binary = resolve(binDir, "turso");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const canonicalBinary = realpathSync(binary);
    const canonicalBinDir = realpathSync(binDir);
    const provider = createTursoCliProvisioningProvider({ searchPath: binDir, home: "/controller/home" });
    const context = target(cwd, artifactDir);

    await expect(provider.inspect(context)).resolves.toEqual({ ready: true });
    await expect(provider.provision({ ...context, credentials: {} })).resolves.toEqual({
      env: { AX_ARENA_TURSO_BIN: canonicalBinary },
      pathEntries: [canonicalBinDir],
      metadata: {
        cli_binary: canonicalBinary,
        cli_bin_dir: canonicalBinDir,
        cli_home: "/controller/home",
        provisioning: "preinstalled-pinned-binary",
      },
    });
  });

  it("rejects a PATH symlink resolving into the writable artifact tree", async () => {
    const cwd = freshDir();
    const artifactDir = resolve(cwd, "artifacts");
    const plantedDir = resolve(artifactDir, "planted");
    mkdirSync(plantedDir, { recursive: true });
    const planted = resolve(plantedDir, "turso-real");
    writeFileSync(planted, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const binDir = resolve(freshDir(), "bin");
    mkdirSync(binDir);
    symlinkSync(planted, resolve(binDir, "turso"));
    const provider = createTursoCliProvisioningProvider({ searchPath: binDir });
    const context = target(cwd, artifactDir);

    await expect(provider.inspect(context)).resolves.toEqual({
      ready: false,
      detail: "preinstalled turso binary must not resolve inside the writable artifact directory",
    });
    await expect(provider.provision({ ...context, credentials: {} }))
      .rejects.toThrow(/writable artifact directory/);
  });

  it("matches only the Turso CLI surface", () => {
    const cwd = freshDir();
    const artifactDir = resolve(cwd, "artifacts");
    mkdirSync(artifactDir);
    const provider = createTursoCliProvisioningProvider({ searchPath: "" });
    const context = target(cwd, artifactDir);
    expect(provider.matches(context)).toBe(true);
    expect(provider.matches({ ...context, cell: { ...context.cell, surface: "api" } })).toBe(false);
  });
});
