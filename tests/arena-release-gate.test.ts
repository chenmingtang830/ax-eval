import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("arena release gate", () => {
  it("blocks ax-eval publication while the arena package is private", () => {
    expect(() => execFileSync(process.execPath, [resolve(".github/verify-arena-release-gate.mjs")], {
      cwd: resolve("."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })).toThrow(/release blocked until the arena compatibility package is available/);
  });
});
