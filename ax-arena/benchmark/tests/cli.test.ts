import { mkdtempSync, rmSync } from "node:fs";
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
    await expect(runArenaCli(["benchmark", "publish"], benchmark.io)).resolves.toBe(1);
    expect(benchmark.stderr[0]).toContain("unknown benchmark command");
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
