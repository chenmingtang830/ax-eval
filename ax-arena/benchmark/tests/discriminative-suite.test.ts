import { describe, expect, it } from "vitest";
import {
  DEFAULT_V21_SELECTION_POLICY,
  selectV21Tasks,
  validateV21FreezeSelection,
  freezeV21Suite,
  type V21Task,
  type CalibrationObservation,
} from "../src/authoring/discriminative-suite.js";

const vendors = ["cockroachdb", "insforge", "neon", "nile", "turso", "supabase"];
const models = ["google/gemini-3.7-flash-20260813", "deepseek/deepseek-v4-flash-20260731"];
const holdout = "z-ai/glm-5.2-20260616";
const families = ["access-auth-discovery", "schema-integrity", "query-search", "lifecycle-recovery"] as const;

function task(id: string, family: (typeof families)[number], anchor = false): V21Task {
  return {
    id, title: id, difficulty: "L3", execution_family: family,
    challenge_tags: ["multi-step-state", "constraint-preservation"], discovery_reset: "family",
    supported_vendors: vendors, anchor, intent: `intent for ${id}`, oracle_hint: `oracle for ${id}`,
  };
}

function observations(items: V21Task[]): CalibrationObservation[] {
  const rates = [0.33, 0.58, 0.67, 0.82, 0.42, 0.73, 0.86, 0.35, 0.64, 0.78, 0.47, 0.69, 0.84];
  return items.filter((item) => !item.anchor).flatMap((item, index) => {
    const threshold = rates[index]!;
    return vendors.flatMap((vendor, vendorIndex) => [...models, holdout].map((model, modelIndex) => ({
      task_id: item.id, vendor, model, harness: "pi" as const, trial: 1,
      status: ((vendorIndex + modelIndex * 2) / vendors.length < threshold ? "pass" : "fail") as "pass" | "fail",
      strict_pass: vendorIndex % 2 === 0, recovery_pass: modelIndex === 0,
    })));
  });
}

function candidates(): V21Task[] {
  return [
    task("db-T02-evolve-schema", "schema-integrity", true),
    task("db-T04-query-records", "query-search", true),
    task("db-T06-write-records", "lifecycle-recovery", true),
    ...["access-1", "access-2", "access-3", "access-4"].map((id) => task(id, "access-auth-discovery")),
    ...["schema-1", "schema-2", "schema-3"].map((id) => task(id, "schema-integrity")),
    ...["query-1", "query-2", "query-3"].map((id) => task(id, "query-search")),
    ...["life-1", "life-2", "life-3"].map((id) => task(id, "lifecycle-recovery")),
  ];
}

describe("V2.1 discriminative suite selection", () => {
  it("reports an unsatisfiable family quota before backtracking", () => {
    const items = candidates();
    const calibrated = observations(items).map((observation) => {
      if (observation.task_id === "access-2") return { ...observation, status: "pass" as const };
      if (observation.task_id === "access-3" || observation.task_id === "access-4") return { ...observation, status: "fail" as const };
      return observation;
    });
    expect(() => selectV21Tasks(items, calibrated)).toThrow(/unsatisfiable for access-auth-discovery/);
  });

  it("retains anchors and fills exact family quotas deterministically", () => {
    const items = candidates();
    const result = selectV21Tasks(items, observations(items));
    expect(result.selected).toHaveLength(10);
    expect(result.policy).toEqual(DEFAULT_V21_SELECTION_POLICY);
    expect(result.selected.filter((item) => item.anchor)).toHaveLength(3);
    for (const family of families) expect(result.selected.filter((item) => item.execution_family === family)).toHaveLength(result.policy.family_counts[family] ?? 0);
    expect(result.selection_hash).toMatch(/^[a-f0-9]{64}$/);
    validateV21FreezeSelection(result);
  });

  it("rejects a family without admitted candidates", () => {
    const items = candidates().map((item) => item.execution_family === "access-auth-discovery"
      ? { ...item, execution_family: "query-search" as const } : item);
    expect(() => selectV21Tasks(items, observations(items))).toThrow(/unsatisfiable for access-auth-discovery/);
  });

  it("uses concrete task-fit vendors instead of broad cited coverage", () => {
    const items = candidates().map((item) => item.execution_family === "access-auth-discovery"
      ? { ...item, task_fit_vendors: vendors.slice(0, 4) } : item);
    expect(() => selectV21Tasks(items, observations(items))).toThrow(/unsatisfiable for access-auth-discovery/);
  });

  it("writes a hash-bound frozen suite and manifest", () => {
    const items = candidates();
    const result = selectV21Tasks(items, observations(items));
    const frozen = freezeV21Suite(result, { candidates: "a".repeat(64) });
    expect(frozen.yaml).toContain("DAEB-2-CLI-V2.1-Harness-Neutral");
    expect(frozen.yaml).not.toContain("controller_fixture_ref");
    expect(frozen.yaml).toContain("allowed_surfaces:");
    expect(frozen.yaml).toContain("- cli");
    expect(frozen.manifest).toHaveProperty("controller_fixture_plan");
    expect(frozen.manifest).toMatchObject({ production_eligible: false, freeze_gates: { docs: null, review: null } });
    expect(frozen.manifest).toMatchObject({ immutable: true, selection_hash: result.selection_hash });
  });
});
