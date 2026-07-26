import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertExpectedConfigurationSource,
  assertHarnessVersionOutput,
  parseExactCredentialBundle,
} from "../scripts/trusted-script-common.js";

describe("trusted workflow entrypoints", () => {
  it("fails the planner and worker closed outside their reviewed GitHub jobs", () => {
    for (const [name, expected] of [
      ["prepare-trusted-plan.ts", "credential-free GitHub Actions plan job"],
      ["trusted-worker.ts", "reviewed GitHub Actions environment"],
    ] as const) {
      const script = resolve(process.cwd(), "scripts", name);
      const result = spawnSync(process.execPath, ["--import", "tsx", script], {
        cwd: resolve(process.cwd(), "../.."),
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(expected);
    }
  });

  it("keeps the matrix worker scoped to exactly one preplanned cell", () => {
    const source = readFileSync(resolve(process.cwd(), "scripts", "trusted-worker.ts"), "utf8");
    expect(source).toContain('oneFlag(flags, "--cell-key")');
    expect(source).toContain('oneFlag(flags, "--configuration-source")');
    expect(source).toContain('new URL("../dist/index.js", import.meta.url)');
    expect(source).not.toContain('await import("../src/index.js")');
    expect(source).toContain('oneFlag(flags, "--configuration-sha256")');
    expect(source).toContain('oneFlag(flags, "--runtime-manifest")');
    expect(source).toContain("assertTrustedRuntimeManifest(");
    expect(source).toContain("selectArenaWorkerCell");
    expect(source).toContain("executeArenaWorkerCell");
    expect(source).toContain("runtimeManifestSha256: runtimeManifest.sha256");
    expect(source).toContain("await import(arenaRuntimeModule)");
    expect(source).not.toContain('await import("../src/index.js")');
    expect(source).not.toContain("resolveBatchIdentity");
    expect(source).not.toContain("writeBatchCompletion");
    expect(source).not.toMatch(/for\s*\([^)]*\.cells/);
    expect(source.indexOf("attestTrustedHarnessBinary({")).toBeLessThan(source.indexOf("const credentials ="));
    expect(source.indexOf("assertTrustedRuntimeManifest(")).toBeLessThan(source.indexOf("const credentials ="));
    expect(source.indexOf("attestTrustedHarnessBinary({")).toBeLessThan(source.indexOf("executeArenaWorkerCell("));
    expect(source.indexOf("delete process.env.AX_ARENA_CELL_CREDENTIALS_JSON"))
      .toBeLessThan(source.indexOf("executeArenaWorkerCell("));
    for (const name of ["cell-result.json", "record.normalized.json", "cleanup.json"]) {
      expect(source).toContain(name);
    }
    expect(source).toContain("`artifact-${artifact.name}.bin`");
    expect(source).toContain("ax.arena-cell-transfer/v1");
    expect(source).toContain("constants.O_NOFOLLOW");
  });

  it("materializes only the exact credential-name bundle after harness attestation", () => {
    expect(parseExactCredentialBundle(
      JSON.stringify({ OPENAI_API_KEY: "host-secret", DATABASE_URL: "verify-secret" }),
      ["DATABASE_URL", "OPENAI_API_KEY"],
    )).toEqual({ OPENAI_API_KEY: "host-secret", DATABASE_URL: "verify-secret" });
    expect(() => parseExactCredentialBundle(
      JSON.stringify({ OPENAI_API_KEY: "host-secret", ANTHROPIC_API_KEY: "other-secret" }),
      ["OPENAI_API_KEY"],
    )).toThrow(/names do not match/);
    expect(() => parseExactCredentialBundle("not-json", ["OPENAI_API_KEY"]))
      .toThrow(/valid JSON/);
  });

  it("rejects the installed harness version before credential materialization", () => {
    expect(() => assertHarnessVersionOutput("codex 1.2.4", "codex 1.2.3", "1.2.3"))
      .toThrow(/installed harness version/);
    expect(() => assertHarnessVersionOutput("codex 1.2.3", "codex 1.2.3", "1.2.3"))
      .not.toThrow();
  });

  it("requires an external controller attestation for the committed configuration", () => {
    const source = { path: "ax-arena/benchmark/daeb/v1/batch.json", file_hash: "a".repeat(64) };
    expect(() => assertExpectedConfigurationSource(source, source.path, source.file_hash)).not.toThrow();
    expect(() => assertExpectedConfigurationSource(source, source.path, "b".repeat(64)))
      .toThrow(/external controller attestation/);
  });

  it("keeps completion assembly separate from execution and credentials", () => {
    const source = readFileSync(resolve(process.cwd(), "scripts", "assemble-trusted-completion.ts"), "utf8");
    expect(source).toContain("writeBatchCompletionFromResults");
    expect(source).toContain('flags.get("--cell-result")');
    expect(source).toContain('flags.get("--cell-results-root")');
    expect(source).toContain('oneFlag(flags, "--configuration-source")');
    expect(source).toContain("regularTreeFiles(transfersRoot)");
    expect(source).toContain("trusted arena cell transfer set does not exactly match");
    expect(source).toContain("arenaCellResultPath(runRoot, cell)");
    expect(source).not.toContain("executeArenaCell");
    expect(source).not.toContain("executeArenaWorkerCell");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("credentials");
  });
});
