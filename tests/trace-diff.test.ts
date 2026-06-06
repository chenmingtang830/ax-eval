import { describe, expect, it } from "vitest";
import { TargetPackSchema } from "../src/schemas.js";
import type { TraceStep } from "../src/harness/executor.js";
import { diffTrace, renderTraceDiffs } from "../src/harness/trace-diff.js";

const pack = TargetPackSchema.parse({
  name: "demo",
  base_url: "https://api.demo.test",
  tasks: [
    {
      id: "create-task",
      difficulty: "L1",
      prompt: "Create a task",
      create_path: "/tasks",
      oracles: [],
    },
    {
      id: "archive-task",
      difficulty: "L4",
      prompt: "Archive a task",
      oracles: [],
      trace: [
        { type: "forbidden_call", taskId: "archive-task", method: "DELETE", path: "/tasks" },
        { type: "order", before: "create-task", after: "archive-task" },
      ],
    },
  ],
});

describe("trace diff", () => {
  it("passes when inferred create calls match", () => {
    const trace: TraceStep[] = [
      { step: 1, taskId: "create-task", action: "create", method: "POST", path: "/tasks", status: 201 },
      { step: 2, taskId: "archive-task", action: "archive", method: "POST", path: "/tasks/1", status: 200 },
    ];
    expect(diffTrace(pack, trace)).toEqual([]);
    expect(renderTraceDiffs([])).toContain("PASS");
  });

  it("reports missing and argument mismatches for required calls", () => {
    const missing = diffTrace(pack, []);
    expect(missing.some((d) => d.kind === "missing_call" && d.taskId === "create-task")).toBe(true);

    const wrongPath = diffTrace(pack, [
      { step: 1, taskId: "create-task", action: "create", method: "POST", path: "/projects", status: 201 },
    ]);
    expect(wrongPath.some((d) => d.kind === "argument_mismatch")).toBe(true);
  });

  it("reports forbidden, order, and extra calls", () => {
    const diffs = diffTrace(pack, [
      { step: 1, taskId: "archive-task", action: "delete", method: "DELETE", path: "/tasks", status: 204 },
      { step: 2, taskId: "create-task", action: "create", method: "POST", path: "/tasks", status: 201 },
      { step: 3, taskId: "surprise", action: "extra", method: "POST", path: "/users", status: 201 },
    ]);
    expect(diffs.map((d) => d.kind)).toEqual(expect.arrayContaining(["forbidden_call", "order_mismatch", "extra_call"]));
    expect(renderTraceDiffs(diffs)).toContain("FAIL");
  });
});
