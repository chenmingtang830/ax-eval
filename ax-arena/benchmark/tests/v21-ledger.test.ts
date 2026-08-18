import { describe, expect, it } from "vitest";
import { planV21Invocations, taskObservationsForInvocation } from "../src/runtime/v21-execution.js";
import {
  buildV21ResultLedger,
  macroAverageV21Scores,
  scoreV21Ledger,
  validateV21ResultLedger,
} from "../src/publication/v21-ledger.js";
import type { V21Task } from "../src/authoring/discriminative-suite.js";

const vendors = ["cockroachdb", "insforge", "neon", "nile", "turso", "supabase"];
const tasks: V21Task[] = [
  { id: "a", title: "a", difficulty: "L2", execution_family: "access-auth-discovery", challenge_tags: ["surface-ambiguity"], discovery_reset: "family", supported_vendors: vendors, anchor: false, intent: "a", oracle_hint: "a" },
  { id: "b", title: "b", difficulty: "L3", execution_family: "schema-integrity", challenge_tags: ["constraint-preservation"], discovery_reset: "family", supported_vendors: vendors, anchor: false, intent: "b", oracle_hint: "b" },
  { id: "c", title: "c", difficulty: "L2", execution_family: "query-search", challenge_tags: ["multi-step-state"], discovery_reset: "family", supported_vendors: vendors, anchor: false, intent: "c", oracle_hint: "c" },
  { id: "d", title: "d", difficulty: "L3", execution_family: "lifecycle-recovery", challenge_tags: ["recovery"], discovery_reset: "family", supported_vendors: vendors, anchor: false, intent: "d", oracle_hint: "d" },
];

describe("V2.1 result ledger", () => {
  it("keeps all 432 cells and exposes pass@1/pass@3 slices", () => {
    const plans = planV21Invocations(vendors, tasks);
    const cells = plans.map((plan) => ({ ...plan, status: plan.status === "structural-na" ? "structural-na" as const : "pass" as const }));
    const observations = plans.flatMap((plan) => plan.status === "structural-na"
      ? []
      : taskObservationsForInvocation(plan, Object.fromEntries(plan.task_ids.map((id) => [id, "pass" as const]))).map((observation) => ({
        ...observation,
        discovery_score: 0.8,
        strict_pass: true,
        recovery_pass: true,
        latency_ms: 100,
        ttft_ms: 20,
        tool_calls: 3,
        cost_usd: 0.01,
        tokens: 100,
      })));
    const ledger = buildV21ResultLedger(plans, cells, observations);
    validateV21ResultLedger(ledger);
    expect(ledger.cells).toHaveLength(432);
    expect(scoreV21Ledger(ledger)).toHaveLength(36);
    expect(scoreV21Ledger(ledger)[0]?.pass_at_3).toBe(1);
    expect(scoreV21Ledger(ledger)[0]).toMatchObject({ discovery_mean: expect.closeTo(0.8), ax_harmonic_mean: expect.closeTo(0.8888888889), strict_rate: 1, recovery_rate: 1 });
    expect(macroAverageV21Scores(scoreV21Ledger(ledger))).toHaveLength(3);
    expect(macroAverageV21Scores(scoreV21Ledger(ledger), "model-harness")).toHaveLength(6);
  });

  it("rejects pending, missing, or route-invalid final cells", () => {
    const plans = planV21Invocations(vendors, tasks);
    const cells = plans.slice(0, -1).map((plan) => ({ ...plan, status: "pass" as const }));
    expect(() => buildV21ResultLedger(plans, cells, [])).toThrow(/needs 432 cells/);
    const full = plans.map((plan) => ({ ...plan, status: plan.status === "structural-na" ? "structural-na" as const : "invalid-route" as const }));
    const ledger = buildV21ResultLedger(plans, full, []);
    expect(() => validateV21ResultLedger(ledger)).toThrow(/invalid-route/);
  });
});
