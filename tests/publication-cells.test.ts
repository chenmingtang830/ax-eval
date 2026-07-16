import { describe, expect, it } from "vitest";
import { buildPublicationCellsExport } from "../src/generate/publication-cells.js";
import { buildPublicationManifest } from "../src/generate/publication-manifest.js";
import { NORMALIZED_RESULT_SCHEMA, type NormalizedResult } from "../src/generate/record.js";

const SHA256 = "a".repeat(64);

function aggregate(overrides: Partial<NormalizedResult> = {}): NormalizedResult {
  return {
    schema: NORMALIZED_RESULT_SCHEMA,
    product: "acme",
    surface: "api",
    harness: "codex",
    standard_set_version: "suite-v1",
    generated_at: "2026-07-16T10:00:00.000Z",
    tasks_total: 2,
    tasks_passed: 1,
    pass_at_1: 0.5,
    pass_at_k: 0.75,
    attempts: 1,
    discovery_score: 0.8,
    content_quality: 0.9,
    profiles: ["medium"],
    best_profile: "medium",
    model: "model-a",
    latency_ms: 1500,
    validity_status: "valid",
    first_action_latency_ms: 100,
    summary_kind: "aggregate",
    trial_count: 3,
    trial_values: [1, 0.5, 0],
    mean_pass_rate: 0.5,
    range_pass_rate: { min: 0, max: 1 },
    pass_hat_3: 0.125,
    pass_all_3: 0,
    trial_stability_at_3: "inconsistent",
    source_records: ["runs/acme/api/codex/trial-1.json", "runs/acme/api/codex/trial-2.json", "runs/acme/api/codex/trial-3.json"],
    ...overrides,
  };
}

function manifest() {
  return buildPublicationManifest({
    benchmark: "Database Suite",
    category: "database",
    suiteVersion: 1,
    standardSetVersion: "suite-v1",
    vendors: [
      { vendor: "beta", surfaces: ["api"] },
      { vendor: "acme", surfaces: ["api"] },
    ],
    harnesses: ["codex"],
    requiredProfiles: ["medium"],
    requiredTrialCount: 3,
    artifacts: [],
    cells: [
      { vendor: "beta", surface: "api", harness: "codex", profiles: ["medium"], trial_count: 3, aggregate_record: "vendors/beta/api/codex/aggregate.json", aggregate_sha256: SHA256 },
      { vendor: "acme", surface: "api", harness: "codex", profiles: ["medium"], trial_count: 3, aggregate_record: "vendors/acme/api/codex/aggregate.json", aggregate_sha256: SHA256 },
    ],
    now: () => new Date("2026-07-16T11:00:00.000Z"),
  });
}

describe("buildPublicationCellsExport", () => {
  it("builds deterministic cells from manifest-bound aggregate records", () => {
    const output = buildPublicationCellsExport({
      manifest: manifest(),
      records: [
        { path: "vendors/beta/api/codex/aggregate.json", record: aggregate({ product: "beta" }) },
        { path: "vendors/acme/api/codex/aggregate.json", record: aggregate() },
      ],
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });
    expect(output.generated_at).toBe("2026-07-16T12:00:00.000Z");
    expect(output.standard_set_version).toBe("suite-v1");
    expect(output.cells.map((cell) => cell.id)).toEqual(["acme/api/codex", "beta/api/codex"]);
    expect(output.cells[0]).toEqual(expect.objectContaining({
      mean_success_rate: 0.5,
      trial_count: 3,
      aggregate_record: "vendors/acme/api/codex/aggregate.json",
    }));
    expect(output.cells[0]).not.toHaveProperty("transcript");
    expect(output.cells[0]).not.toHaveProperty("token_usage");
  });

  it("rejects missing, duplicate, undeclared, and single-run records", () => {
    const publication = manifest();
    const acme = { path: "vendors/acme/api/codex/aggregate.json", record: aggregate() };
    const beta = { path: "vendors/beta/api/codex/aggregate.json", record: aggregate({ product: "beta" }) };
    expect(() => buildPublicationCellsExport({ manifest: publication, records: [acme] })).toThrow(/record count/);
    expect(() => buildPublicationCellsExport({ manifest: publication, records: [acme, acme] })).toThrow(/appears more than once/);
    expect(() => buildPublicationCellsExport({ manifest: publication, records: [
      acme,
      { ...beta, path: "vendors/other/api/codex/aggregate.json" },
    ] })).toThrow(/not declared/);
    expect(() => buildPublicationCellsExport({ manifest: publication, records: [
      { ...acme, record: aggregate({ summary_kind: "single" }) },
      beta,
    ] })).toThrow(/must use an aggregate/);
  });

  it("rejects identity, profile, trial, metric, and provenance mismatches", () => {
    const publication = manifest();
    const beta = { path: "vendors/beta/api/codex/aggregate.json", record: aggregate({ product: "beta" }) };
    const check = (record: NormalizedResult, pattern: RegExp) => {
      expect(() => buildPublicationCellsExport({
        manifest: publication,
        records: [{ path: "vendors/acme/api/codex/aggregate.json", record }, beta],
      })).toThrow(pattern);
    };
    check(aggregate({ product: "other" }), /product does not match/);
    check(aggregate({ profiles: ["low"] }), /profiles do not match/);
    check(aggregate({ trial_count: 2 }), /trial count does not match/);
    check(aggregate({ standard_set_version: "suite-v2" }), /standard set does not match/);
    check(aggregate({ mean_pass_rate: 2 }), /finite rate/);
    check(aggregate({ range_pass_rate: { min: 0.75, max: 1 } }), /invalid success-rate range/);
    check(aggregate({ trial_values: [1, 1, 0] }), /aggregate metrics do not match/);
    check(aggregate({ source_records: [] }), /source records do not match/);
    check(aggregate({ source_records: ["../secret.json"] }), /portable relative path/);
    check(aggregate({ pass_hat_3: 0.5 }), /three-trial metrics do not match/);
    check(aggregate({ blocked: "invoke-failed" }), /cannot publish a blocked record/);
    check(aggregate({ latency_ms: -1 }), /non-negative finite number/);
  });
});
