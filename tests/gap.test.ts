import { describe, expect, it } from "vitest";
import { renderGap } from "../src/static/render.js";
import type { RunReport } from "../src/runner.js";
import type { StaticAudit } from "../src/static/types.js";

const audit = (score: number): StaticAudit => ({
  site: "https://x.com",
  score,
  checks: [],
  errored: 0,
  source: "fixture",
});

function report(rows: { harness: string; success: boolean }[], synthetic: string[]): RunReport {
  const harnesses = [...new Set(rows.map((r) => r.harness))];
  return {
    pack: "x",
    packVersion: "0",
    harnesses,
    synthetic,
    results: rows.map((r, i) => ({
      taskId: `t${i}`,
      harness: r.harness,
      success: r.success,
      oracleResults: [],
      trace: [],
      durationMs: 0,
      error: null,
    })),
  };
}

describe("renderGap", () => {
  it("excludes a synthetic perfect mock from the gap (the A1 bug)", () => {
    // mock passes 100% but is synthetic; the real agent only 40%.
    const r = report(
      [
        { harness: "mock", success: true },
        { harness: "hermes", success: true },
        { harness: "hermes", success: false },
        { harness: "hermes", success: false },
        { harness: "hermes", success: false },
        { harness: "hermes", success: true },
      ],
      ["mock"],
    );
    const out = renderGap(audit(90), r);
    // Best *real* agent is hermes at 40%, so a 50-point gap must surface.
    expect(out).toContain("50-point gap");
    expect(out).toContain("(synthetic control)");
  });

  it("does not let a perfect synthetic mock erase the gap", () => {
    const r = report([{ harness: "mock", success: true }], ["mock"]);
    const out = renderGap(audit(90), r);
    // Only a synthetic control ran → gap not measurable, NOT "no positive gap".
    expect(out).toContain("gap not measurable");
  });

  it("reports a harness with no results as 'not run', not 0%", () => {
    const r: RunReport = {
      pack: "x",
      packVersion: "0",
      harnesses: ["hermes", "claude-code"],
      synthetic: [],
      results: [
        { taskId: "t0", harness: "hermes", success: true, oracleResults: [], trace: [], durationMs: 0, error: null },
      ],
    };
    const out = renderGap(audit(80), r);
    expect(out).toContain("not run");
    // claude-code never ran, so it must not be counted as 0% in the gap.
    expect(out).not.toContain("claude-code   0% of tasks");
  });
});
