import { describe, it, expect } from "vitest";
import { TargetPackSchema, type TargetPack } from "../src/schemas.js";
import {
  buildNormalizedResult,
  buildNormalizedResultCells,
  discoveryScore,
  NORMALIZED_RESULT_SCHEMA,
} from "../src/generate/record.js";
import type { ProfileRun } from "../src/generate/report.js";
import type { RoundtripOutcome } from "../src/generate/verify.js";
import type { DiscoveryReport, DiscoveryMetric } from "../src/generate/discovery.js";

function makePack(name: string): TargetPack {
  return TargetPackSchema.parse({
    name,
    standard_set_version: `${name}-2026-06-05`,
    base_url: `https://api.${name}.test`,
    discovery: { product: name },
    tasks: [
      { id: "t1", difficulty: "L1", prompt: "Create a thing.", oracles: [{ type: "roundtrip", readPathTemplate: "/x/{gid}", assertField: "ok", expected: true }] },
      { id: "t2", difficulty: "L2", prompt: "Create another.", oracles: [{ type: "roundtrip", readPathTemplate: "/x/{gid}", assertField: "ok", expected: true }] },
    ],
  });
}

function outcome(taskId: string, success: boolean, profile = "ceiling"): RoundtripOutcome {
  return {
    taskId,
    difficulty: taskId === "t1" ? "L1" : "L2",
    profile,
    success,
    oracleResults: [{ type: "roundtrip", passed: success, detail: "ok" }],
    error: null,
  };
}

function discovery(passed: Partial<Record<DiscoveryMetric["id"], boolean>>): DiscoveryReport {
  const ids: DiscoveryMetric["id"][] = ["official", "canonical", "misled", "auth"];
  return { hops: 2, metrics: ids.map((id) => ({ id, passed: passed[id] ?? true, detail: id })) };
}

describe("discoveryScore", () => {
  it("is the fraction of scored signals passed, excluding hops", () => {
    expect(discoveryScore(discovery({}))).toBe(1); // all 4 pass
    expect(discoveryScore(discovery({ auth: false }))).toBe(0.75); // 3/4
    expect(discoveryScore(undefined)).toBeNull();
  });
});

describe("buildNormalizedResult", () => {
  it("tags the cube cell and computes best-profile pass@1 / pass@k", () => {
    const pack = makePack("asana");
    const runs: ProfileRun[] = [
      {
        profile: "ceiling",
        surface: "api",
        discovery: discovery({ auth: false }),
        outcomes: [outcome("t1", true), outcome("t2", true)],
      },
      {
        profile: "floor",
        surface: "api",
        discovery: discovery({ official: false, auth: false }),
        outcomes: [outcome("t1", true, "floor"), outcome("t2", false, "floor")],
      },
    ];
    const rec = buildNormalizedResult(pack, "api", "claude-code", runs);
    expect(rec.schema).toBe(NORMALIZED_RESULT_SCHEMA);
    expect(rec.surface).toBe("api");
    expect(rec.product).toBe("asana");
    expect(rec.harness).toBe("claude-code");
    expect(rec.standard_set_version).toBe("asana-2026-06-05");
    // Best profile is ceiling (2/2); pass@1 = 1.
    expect(rec.best_profile).toBe("ceiling");
    expect(rec.pass_at_1).toBe(1);
    expect(rec.tasks_total).toBe(2);
    expect(rec.tasks_passed).toBe(2);
    // Discovery score reported from the best (ceiling) profile: 3/4.
    expect(rec.discovery_score).toBe(0.75);
    expect(rec.profiles).toEqual(["ceiling", "floor"]);
    // Content quality defaults to null (not measured) when not passed.
    expect(rec.content_quality).toBeNull();
  });

  it("records the content-quality score (0–1) when provided", () => {
    const pack = makePack("asana");
    const runs: ProfileRun[] = [
      { profile: "ceiling", surface: "api", outcomes: [outcome("t1", true)] },
    ];
    const rec = buildNormalizedResult(pack, "api", "host", runs, 0.72);
    expect(rec.content_quality).toBe(0.72);
  });

  it("computes pass@k across repeated attempts (best profile)", () => {
    const pack = makePack("notion");
    // Two attempts of the same profile/task: fails once, passes once → pass@k=1, pass@1 (first attempt) depends on order.
    const runs: ProfileRun[] = [
      {
        profile: "ceiling",
        surface: "sdk",
        outcomes: [
          outcome("t1", false), // first attempt of t1 fails
          outcome("t1", true), // second attempt of t1 passes
          outcome("t2", true),
          outcome("t2", true),
        ],
      },
    ];
    const rec = buildNormalizedResult(pack, "sdk", "host", runs);
    expect(rec.attempts).toBe(2);
    // pass@1 uses first attempt per task: t1 fail, t2 pass → 1/2.
    expect(rec.pass_at_1).toBe(0.5);
    expect(rec.tasks_total).toBe(2);
    // pass@k: both tasks solved on ≥1 attempt → 2/2 = 1.
    expect(rec.pass_at_k).toBe(1);
  });

  it("handles empty runs without throwing", () => {
    const rec = buildNormalizedResult(makePack("x"), "mcp", "host", []);
    expect(rec.best_profile).toBeNull();
    expect(rec.pass_at_1).toBe(0);
    expect(rec.pass_at_k).toBe(0);
    expect(rec.discovery_score).toBeNull();
  });

  it("splits mixed report runs into normalized harness/surface cells", () => {
    const pack = makePack("exa-generated");
    const cells = buildNormalizedResultCells(
      pack,
      [
        {
          profile: "low",
          harness: "claude-code",
          surface: "mcp",
          discovery: discovery({ auth: false }),
          outcomes: [outcome("t1", true, "low"), outcome("t2", true, "low")],
        },
        {
          profile: "high",
          harness: "claude-code",
          surface: "mcp",
          discovery: discovery({}),
          outcomes: [outcome("t1", true, "high"), outcome("t2", true, "high")],
        },
        {
          profile: "low",
          harness: "codex",
          surface: "api",
          discovery: discovery({ canonical: false }),
          outcomes: [outcome("t1", true, "low"), outcome("t2", false, "low")],
        },
      ],
      0.7,
    );
    expect(cells.map((c) => c.fileStem).sort()).toEqual(["claude-code.mcp", "codex.api"]);
    const mcp = cells.find((c) => c.fileStem === "claude-code.mcp")!.record;
    expect(mcp.product).toBe("exa");
    expect(mcp.surface).toBe("mcp");
    expect(mcp.harness).toBe("claude-code");
    expect(mcp.profiles).toEqual(["low", "high"]);
    expect(mcp.pass_at_1).toBe(1);
    expect(mcp.content_quality).toBe(0.7);
  });

  it("uses fallback harness before grouping normalized cells", () => {
    const pack = makePack("neon");
    const cells = buildNormalizedResultCells(
      pack,
      [
        {
          profile: "low",
          harness: "codex",
          surface: "cli",
          outcomes: [outcome("t1", true, "low"), outcome("t2", false, "low")],
        },
        {
          profile: "high",
          surface: "cli",
          outcomes: [outcome("t1", true, "high"), outcome("t2", true, "high")],
        },
      ],
      null,
      "codex",
    );
    expect(cells).toHaveLength(1);
    expect(cells[0]!.fileStem).toBe("codex.cli");
    expect(cells[0]!.record.harness).toBe("codex");
    expect(cells[0]!.record.profiles).toEqual(["low", "high"]);
  });
});
