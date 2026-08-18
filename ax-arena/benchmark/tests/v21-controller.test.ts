import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildV21ControllerPlan,
  classifyV21CellStatus,
  isResumableV21Checkpoint,
  v21ExecPlanArgs,
  writeV21Checkpoint,
  readV21Checkpoint,
} from "../src/runtime/v21-controller.js";
import type { V21Task } from "../src/authoring/discriminative-suite.js";

const vendors = ["cockroachdb", "insforge", "neon", "nile", "turso", "supabase"];
const tasks: V21Task[] = [
  { id: "a", title: "a", difficulty: "L2", execution_family: "access-auth-discovery", challenge_tags: ["surface-ambiguity"], discovery_reset: "family", supported_vendors: vendors, anchor: false, intent: "a", oracle_hint: "a" },
  { id: "b", title: "b", difficulty: "L3", execution_family: "schema-integrity", challenge_tags: ["constraint-preservation"], discovery_reset: "family", supported_vendors: vendors, anchor: false, intent: "b", oracle_hint: "b" },
  { id: "c", title: "c", difficulty: "L2", execution_family: "query-search", challenge_tags: ["negative-verification"], discovery_reset: "family", supported_vendors: vendors, anchor: false, intent: "c", oracle_hint: "c" },
  { id: "d", title: "d", difficulty: "L3", execution_family: "lifecycle-recovery", challenge_tags: ["recovery"], discovery_reset: "family", supported_vendors: vendors, anchor: false, intent: "d", oracle_hint: "d" },
];

describe("V2.1 formal controller", () => {
  it("builds the immutable 432-cell plan and pins route args", () => {
    const root = mkdtempSync(join(tmpdir(), "daeb-v21-controller-"));
    const plan = buildV21ControllerPlan({
      suitePath: join(root, "suite.yaml"),
      suiteHash: "a".repeat(64),
      vendors,
      tasks,
      runRoot: root,
    });
    expect(plan.planned_invocations).toBe(432);
    const cell = plan.invocations.find((item) => item.vendor === "neon" && item.harness === "pi" && item.model.startsWith("google/") && item.trial === 2 && item.family === "query-search")!;
    const args = v21ExecPlanArgs({
      packPath: join(root, "pack.yaml"),
      runDir: join(root, "cells", cell.invocation_id),
      plan: cell,
      gatewayUrl: "http://127.0.0.1:43123/v1",
      provider: "google-vertex",
      dataCollection: "allow",
      harness: "pi",
      model: cell.model,
    });
    expect(args).toContain("--invoke-retries");
    expect(args[args.indexOf("--invoke-retries") + 1]).toBe("0");
    expect(args).toContain("--openrouter-provider");
    expect(args).toContain("google-vertex");
    expect(args).toContain("--openrouter-data-collection");
    expect(args).toContain("allow");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe(`openrouter/${cell.model}`);
  });

  it("only resumes a terminal checkpoint with matching identity and artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "daeb-v21-checkpoint-"));
    const plan = buildV21ControllerPlan({ suitePath: join(root, "suite.yaml"), suiteHash: "b".repeat(64), vendors, tasks, runRoot: root });
    const cell = plan.invocations[0]!;
    const artifacts = join(root, "cells", cell.invocation_id, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const path = writeV21Checkpoint(root, {
      schema: "ax.daeb-v2-1-controller-checkpoint/v1",
      invocation_id: cell.invocation_id,
      vendor: cell.vendor,
      harness: cell.harness,
      model: cell.model,
      trial: cell.trial,
      family: cell.family,
      namespace: cell.namespace,
      status: "fail",
      attempts: 1,
      artifact_dir: artifacts,
      updated_at: new Date().toISOString(),
    });
    expect(readV21Checkpoint(root, cell.invocation_id)?.status).toBe("fail");
    expect(path).toContain(cell.invocation_id);
    expect(isResumableV21Checkpoint(cell, readV21Checkpoint(root, cell.invocation_id))).toBe(true);
    expect(isResumableV21Checkpoint({ ...cell, namespace: "different" }, readV21Checkpoint(root, cell.invocation_id))).toBe(false);
  });

  it("fails closed on route or infrastructure defects", () => {
    const root = mkdtempSync(join(tmpdir(), "daeb-v21-status-"));
    const plan = buildV21ControllerPlan({ suitePath: join(root, "suite.yaml"), suiteHash: "c".repeat(64), vendors, tasks, runRoot: root });
    const cell = plan.invocations.find((item) => item.status === "pending")!;
    expect(classifyV21CellStatus({ plan: cell, routeMismatch: true, taskStatuses: ["pass"] })).toBe("invalid-route");
    expect(classifyV21CellStatus({ plan: cell, infraInvalid: true, taskStatuses: ["pass"] })).toBe("invalid-infra");
    expect(classifyV21CellStatus({ plan: cell, taskStatuses: ["pass", "fail"] })).toBe("fail");
    expect(classifyV21CellStatus({ plan: cell, taskStatuses: ["pass", "pass"] })).toBe("pass");
  });
});
