import { describe, it, expect } from "vitest";
import { TargetPackSchema, type TargetPack } from "../src/schemas.js";
import {
  buildNormalizedResult,
  discoveryScore,
  NORMALIZED_RESULT_SCHEMA,
  type NormalizedResult,
} from "../src/generate/record.js";
import { renderCompetitiveReport, type ProfileRun } from "../src/generate/report.js";
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
});

describe("renderCompetitiveReport", () => {
  function rec(over: Partial<NormalizedResult>): NormalizedResult {
    return {
      schema: NORMALIZED_RESULT_SCHEMA,
      surface: "api",
      product: "asana",
      harness: "claude-code",
      standard_set_version: "asana-2026-06-05",
      generated_at: "2026-06-06T00:00:00.000Z",
      tasks_total: 2,
      tasks_passed: 2,
      pass_at_1: 1,
      pass_at_k: 1,
      attempts: 1,
      discovery_score: 1,
      profiles: ["ceiling"],
      best_profile: "ceiling",
      ...over,
    };
  }

  it("renders cross-surface (per product) and cross-product (per surface) sections", () => {
    const records: NormalizedResult[] = [
      rec({ product: "asana", surface: "api", pass_at_1: 0.9 }),
      rec({ product: "asana", surface: "mcp", pass_at_1: 0.5, discovery_score: 0.6 }),
      rec({ product: "notion", surface: "api", pass_at_1: 0.7 }),
    ];
    const html = renderCompetitiveReport(records, { harness: "claude-code" });
    expect(html).toContain("Cross-surface (same product)");
    expect(html).toContain("Cross-product (same surface)");
    // Both products surface in the cross-surface section.
    expect(html).toContain(">asana<");
    expect(html).toContain(">notion<");
    // Surfaces compared for asana.
    expect(html).toContain(">api</td>") ;
    expect(html).toContain(">mcp");
    // Percentages rendered.
    expect(html).toContain("90%");
    expect(html).toContain("50%");
    // No raw template leaks.
    expect(html).not.toContain("undefined%");
    expect(html).not.toContain("[object Object]");
  });

  it("marks the best surface and orders the leaderboard by pass@1", () => {
    const records: NormalizedResult[] = [
      rec({ product: "asana", surface: "api", pass_at_1: 0.4 }),
      rec({ product: "asana", surface: "cli", pass_at_1: 0.8 }),
    ];
    const html = renderCompetitiveReport(records);
    // The higher pass@1 surface (cli) is tagged "best".
    const cliIdx = html.indexOf(">cli");
    const bestIdx = html.indexOf("best</span>");
    expect(cliIdx).toBeGreaterThan(-1);
    expect(bestIdx).toBeGreaterThan(-1);
    // The schema id is documented in the methodology.
    expect(html).toContain(NORMALIZED_RESULT_SCHEMA);
  });

  it("shows an em-dash for unmeasured discovery", () => {
    const html = renderCompetitiveReport([rec({ discovery_score: null })]);
    expect(html).toContain("—");
  });

  it("renders a content-quality column in both planes", () => {
    const records: NormalizedResult[] = [
      rec({ product: "asana", surface: "api", content_quality: 0.82 }),
      rec({ product: "asana", surface: "mcp", content_quality: 0.82 }),
      rec({ product: "notion", surface: "api", content_quality: 0.41 }),
    ];
    const html = renderCompetitiveReport(records);
    // Header cell present in both tables.
    expect(html).toContain("<th>content</th>");
    // The two products' content scores render as heat percentages.
    expect(html).toContain("82%");
    expect(html).toContain("41%");
  });

  it("renders an em-dash for content quality on legacy records (field absent)", () => {
    // Older normalized.json files predate content_quality — must not crash.
    const legacy = { ...rec({}) } as Partial<NormalizedResult>;
    delete legacy.content_quality;
    const html = renderCompetitiveReport([legacy as NormalizedResult]);
    expect(html).toContain("<th>content</th>");
    expect(html).toContain("—");
  });
});
