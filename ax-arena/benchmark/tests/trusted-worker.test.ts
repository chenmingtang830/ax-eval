import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertExpectedConfigurationSource,
  assertHarnessVersionOutput,
} from "../scripts/trusted-script-common.js";

describe("trusted matrix worker boundary", () => {
  it("fails closed outside the reviewed GitHub Actions environment", () => {
    const worker = spawnSync(process.execPath, ["--import", "tsx", resolve(process.cwd(), "scripts", "trusted-worker.ts")], {
      cwd: resolve(process.cwd(), "../.."),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(worker.status).not.toBe(0);
    expect(worker.stderr).toContain("restricted to the reviewed GitHub Actions environment");
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
    expect(source).toContain("await import(arenaRuntimeModule)");
    expect(source).not.toContain('await import("../src/index.js")');
    expect(source).not.toContain("resolveBatchIdentity");
    expect(source).not.toContain("writeBatchCompletion");
    expect(source).not.toMatch(/for\s*\([^)]*\.cells/);
    expect(source.indexOf("attestTrustedHarnessBinary({")).toBeLessThan(source.indexOf("const credentials ="));
    expect(source.indexOf("assertTrustedRuntimeManifest(")).toBeLessThan(source.indexOf("const credentials ="));
    expect(source.indexOf("attestTrustedHarnessBinary({")).toBeLessThan(source.indexOf("executeArenaWorkerCell("));
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
    expect(source).toContain('oneFlag(flags, "--configuration-source")');
    expect(source).not.toContain("executeArenaCell");
    expect(source).not.toContain("executeArenaWorkerCell");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("credentials");
  });
});
