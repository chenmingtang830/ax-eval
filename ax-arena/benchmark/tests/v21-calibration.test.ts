import { describe, expect, it } from "vitest";
import {
  V21_CALIBRATION_MODELS,
  V21_HOLDOUT_MODEL,
  planV21CalibrationInvocations,
  v21CalibrationExecPlanArgs,
} from "../src/runtime/v21-calibration.js";
import type { V21Task } from "../src/authoring/discriminative-suite.js";

const vendors = ["cockroachdb", "insforge", "neon", "nile", "turso", "supabase"];
const tasks: V21Task[] = Array.from({ length: 16 }, (_, index) => ({
  id: `task-${index + 1}`,
  title: `task-${index + 1}`,
  difficulty: "L2",
  execution_family: (["access-auth-discovery", "schema-integrity", "query-search", "lifecycle-recovery"] as const)[index % 4]!,
  challenge_tags: ["surface-ambiguity"],
  discovery_reset: "family",
  supported_vendors: vendors,
  anchor: index < 3,
  intent: "intent",
  oracle_hint: "oracle",
}));

describe("V2.1 calibration planner", () => {
  it("admits the reviewed five-vendor publication core", () => {
    const vendors = ["cockroachdb", "insforge", "neon", "nile", "supabase"];
    const plan = planV21CalibrationInvocations(vendors, tasks);
    expect(plan.invocations).toHaveLength(240);
    expect(new Set(plan.invocations.map((cell) => cell.vendor))).toEqual(new Set(vendors));
  });

  it("plans Pi trial-1 calibration plus GLM holdout without dropping N/A tuples", () => {
    const plan = planV21CalibrationInvocations(vendors, tasks);
    expect(plan.planned_invocations).toBe(288);
    expect(plan.calibration_models).toEqual([...V21_CALIBRATION_MODELS]);
    expect(plan.holdout_model).toBe(V21_HOLDOUT_MODEL);
    expect(plan.invocations.every((cell) => cell.harness === "pi" && cell.trial === 1)).toBe(true);
    expect(plan.invocations.filter((cell) => cell.status === "pending")).toHaveLength(288);
  });

  it("retains structural N/A and refuses to execute it", () => {
    const tasksWithPartialFit = tasks.map((task, index) => index === 0
      ? { ...task, task_fit_vendors: ["Cockroachdb", "Insforge", "Neon", "Nile"] }
      : task);
    const plan = planV21CalibrationInvocations(vendors, tasksWithPartialFit);
    const cell = plan.invocations.find((item) => item.task_id === "task-1" && item.vendor === "supabase" && item.model === V21_CALIBRATION_MODELS[0])!;
    expect(cell.status).toBe("structural-na");
    expect(() => v21CalibrationExecPlanArgs({
      packPath: "/tmp/pack.yaml",
      runDir: "/tmp/run",
      plan: cell,
      gatewayUrl: "http://127.0.0.1:1/v1",
      provider: "google-vertex",
      dataCollection: "allow",
    })).toThrow(/structural N\/A/);
  });

  it("keeps low-coverage candidates in the calibration pool for explicit N/A accounting", () => {
    const lowCoverage = tasks.map((task, index) => index === 1
      ? { ...task, supported_vendors: ["Cockroachdb", "Neon", "Nile", "Supabase"] }
      : task);
    const plan = planV21CalibrationInvocations(vendors, lowCoverage);
    expect(plan.invocations.filter((cell) => cell.task_id === "task-2" && cell.status === "structural-na")).toHaveLength(18);
  });

  it("pins calibration commands to Pi, high effort, no retries, and the gateway", () => {
    const plan = planV21CalibrationInvocations(vendors, tasks);
    const cell = plan.invocations[0]!;
    const args = v21CalibrationExecPlanArgs({
      packPath: "/tmp/pack.yaml",
      runDir: "/tmp/run",
      plan: cell,
      gatewayUrl: "http://127.0.0.1:43123/v1",
      provider: "google-vertex",
      dataCollection: "allow",
    });
    expect(args).toContain("--harness");
    expect(args[args.indexOf("--harness") + 1]).toBe("pi");
    expect(args[args.indexOf("--invoke-retries") + 1]).toBe("0");
    expect(args).toContain("--openrouter-provider");
    expect(args).toContain("google-vertex");
  });

  it("gives repeated trials distinct identities, namespaces, and child trial flags", () => {
    const plan = planV21CalibrationInvocations(vendors, tasks, 2);
    const cell = plan.invocations[0]!;
    expect(cell.trial).toBe(2);
    expect(cell.invocation_id).not.toBe(planV21CalibrationInvocations(vendors, tasks, 1).invocations[0]!.invocation_id);
    expect(cell.namespace).toContain(cell.invocation_id);
    const args = v21CalibrationExecPlanArgs({
      packPath: "/tmp/pack.yaml", runDir: "/tmp/run", plan: cell,
      gatewayUrl: "http://127.0.0.1:43123/v1", provider: "google-vertex", dataCollection: "allow",
    });
    expect(args[args.indexOf("--trial") + 1]).toBe("2");
  });
});
