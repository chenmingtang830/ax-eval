import { describe, expect, it } from "vitest";
import { planV21Invocations, taskObservationsForInvocation, validateV21InvocationPlan } from "../src/runtime/v21-execution.js";
import type { V21Task } from "../src/authoring/discriminative-suite.js";

const vendors = ["cockroachdb", "insforge", "neon", "nile", "turso", "supabase"];
const tasks: V21Task[] = [
  { id: "a", title: "a", difficulty: "L2", execution_family: "access-auth-discovery", challenge_tags: ["surface-ambiguity"], discovery_reset: "family", supported_vendors: vendors, anchor: false, intent: "a", oracle_hint: "a" },
  { id: "b", title: "b", difficulty: "L3", execution_family: "schema-integrity", challenge_tags: ["constraint-preservation"], discovery_reset: "family", supported_vendors: vendors, anchor: false, intent: "b", oracle_hint: "b" },
  { id: "c", title: "c", difficulty: "L2", execution_family: "query-search", challenge_tags: ["multi-step-state"], discovery_reset: "family", supported_vendors: vendors, anchor: false, intent: "c", oracle_hint: "c" },
  { id: "d", title: "d", difficulty: "L3", execution_family: "lifecycle-recovery", challenge_tags: ["recovery"], discovery_reset: "family", supported_vendors: vendors, anchor: false, intent: "d", oracle_hint: "d" },
];

describe("V2.1 family invocation planner", () => {
  it("creates the complete 432-cell factorial plan", () => {
    const plans = planV21Invocations(vendors, tasks);
    validateV21InvocationPlan(plans);
    expect(plans).toHaveLength(432);
    expect(new Set(plans.map((plan) => plan.namespace)).size).toBe(432);
  });

  it("keeps structural N/A family rows present and expands task outcomes", () => {
    const plans = planV21Invocations(vendors, tasks);
    const plan = plans.find((item) => item.vendor === "supabase" && item.family === "access-auth-discovery")!;
    expect(plan.status).toBe("pending");
    expect(taskObservationsForInvocation(plan, { a: "pass" })).toMatchObject([{ task_id: "a", status: "pass" }]);
  });

  it("uses concrete five-of-six task-fit vendors for admission", () => {
    const taskFitTasks: V21Task[] = [
      { ...tasks[0]!, id: "broad", supported_vendors: vendors, task_fit_vendors: ["Cockroachdb", "Insforge", "Neon", "Nile"], },
      { ...tasks[1]!, id: "admitted", supported_vendors: vendors, task_fit_vendors: ["Cockroachdb", "Insforge", "Neon", "Nile", "Turso"], },
      tasks[2]!,
      tasks[3]!,
    ];
    const plans = planV21Invocations(vendors, taskFitTasks);
    const schema = plans.find((item) => item.vendor === "turso" && item.family === "schema-integrity")!;
    expect(schema.status).toBe("pending");
    expect(schema.task_ids).toEqual(["admitted"]);
    const access = plans.find((item) => item.vendor === "supabase" && item.family === "access-auth-discovery")!;
    expect(access.status).toBe("structural-na");
    expect(access.task_ids).toEqual([]);
  });

  it("rejects a non-three-trial production plan", () => {
    expect(() => planV21Invocations(vendors, tasks, 1)).toThrow(/exactly three/);
  });
});
