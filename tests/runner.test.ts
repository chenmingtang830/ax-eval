import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPack } from "../src/config.js";
import { matrix, passRate, run } from "../src/runner.js";

const PACK = resolve(dirname(fileURLToPath(import.meta.url)), "..", "targets", "examples", "asana", "pack.yaml");

describe("runner", () => {
  it("a competent mock passes everything", async () => {
    const pack = loadPack(PACK);
    const report = await run(pack, ["mock"]);
    expect(report.results.length).toBe(pack.tasks.length);
    expect(report.results.every((r) => r.success)).toBe(true);
    expect(passRate(report, "mock")).toBe(1);
  });

  it("a weak mock fails some", async () => {
    const pack = loadPack(PACK);
    const report = await run(pack, ["mock-weak"]);
    const rate = passRate(report, "mock-weak");
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(1);
  });

  it("produces a full matrix with differing rates", async () => {
    const pack = loadPack(PACK);
    const report = await run(pack, ["mock", "mock-weak", "hermes"]);
    const grid = matrix(report);
    expect(Object.keys(grid).sort()).toEqual(pack.tasks.map((t) => t.id).sort());
    for (const row of Object.values(grid)) {
      expect(Object.keys(row).sort()).toEqual(["hermes", "mock", "mock-weak"]);
    }
    // The point of the demo: harnesses succeed at different rates.
    expect(passRate(report, "mock")).toBeGreaterThan(passRate(report, "mock-weak"));
  });

  it("results carry traces, incl. the hermes stub note", async () => {
    const pack = loadPack(PACK);
    const report = await run(pack, ["hermes"]);
    expect(report.results.every((r) => r.trace.length > 0)).toBe(true);
    expect(report.results.some((r) => r.trace.some((l) => l.includes("stub")))).toBe(true);
  });
});
