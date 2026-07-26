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
  it("prints benchmark help", () => {
    const output = capture();
    expect(runArenaCli(["benchmark", "--help"], output.io)).toBe(0);
    expect(output.stdout).toEqual([BENCHMARK_USAGE]);
    expect(output.stderr).toEqual([]);
  });

  it("fails clearly for commands that have not moved yet", () => {
    const output = capture();
    expect(runArenaCli(["benchmark", "publish"], output.io)).toBe(1);
    expect(output.stderr[0]).toContain("not implemented");
  });

  it("rejects unknown top-level command groups", () => {
    const output = capture();
    expect(runArenaCli(["other"], output.io)).toBe(1);
    expect(output.stderr[0]).toContain("unknown ax-arena command");
  });
});
