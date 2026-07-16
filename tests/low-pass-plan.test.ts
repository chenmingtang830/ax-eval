import { describe, expect, it } from "vitest";
import type { TargetPack } from "../src/schemas.js";
import { buildLowPassExecutionPlan } from "../src/generate/low-pass-plan.js";

function pack(): Pick<TargetPack, "name" | "standard_set_version" | "surfaces" | "tasks"> {
  return {
    name: "acme-generated",
    standard_set_version: "suite-v1",
    surfaces: {
      cli: { bin: "acme" },
      sdk: { package: "acme-sdk", language: "node" },
    },
    tasks: [
      {
        id: "shared",
        title: "Shared task",
        difficulty: "L1",
        prompt: "Do the shared task",
        allowed_surfaces: [],
        na: false,
        oracles: [{ type: "roundtrip", readPathTemplate: "/items/{gid}", assertField: "name", expected: "shared" }],
      },
      {
        id: "cli-only",
        title: "CLI task",
        difficulty: "L1",
        prompt: "Do the CLI task",
        allowed_surfaces: ["cli"],
        na: false,
        oracles: [{ type: "roundtrip", readPathTemplate: "/items/{gid}", assertField: "name", expected: "cli" }],
      },
      {
        id: "sdk-na",
        title: "SDK N/A",
        difficulty: "L1",
        prompt: "Not executable",
        allowed_surfaces: ["sdk"],
        na: true,
        oracles: [],
      },
    ],
  };
}

describe("buildLowPassExecutionPlan", () => {
  it("builds deterministic low-profile task cells", () => {
    const plan = buildLowPassExecutionPlan({
      suiteName: "suite",
      standardSetVersion: "suite-v1",
      vendor: "acme",
      pack: pack(),
      surfaces: ["api", "cli", "sdk"],
      harnesses: ["codex", "claude-code"],
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    });

    expect(plan.status).toBe("ready");
    expect(plan.execution_mode).toBe("task");
    expect(plan.generated_at).toBe("2026-07-16T12:00:00.000Z");
    expect(plan.cells.map((cell) => cell.id)).toEqual([
      "acme/api/codex/trial-1",
      "acme/api/claude-code/trial-1",
      "acme/cli/codex/trial-1",
      "acme/cli/claude-code/trial-1",
      "acme/sdk/codex/trial-1",
      "acme/sdk/claude-code/trial-1",
    ]);
    expect(plan.cells.find((cell) => cell.surface === "api")?.task_ids).toEqual(["shared"]);
    expect(plan.cells.find((cell) => cell.surface === "cli")?.task_ids).toEqual(["shared", "cli-only"]);
    expect(plan.cells.every((cell) => cell.profile === "low" && cell.trial === 1)).toBe(true);
  });

  it("records surfaces with no executable tasks instead of silently dropping them", () => {
    const onlyNa = pack();
    onlyNa.tasks = onlyNa.tasks.filter((task) => task.id === "sdk-na");
    const plan = buildLowPassExecutionPlan({
      suiteName: "suite",
      standardSetVersion: "suite-v1",
      vendor: "acme",
      pack: onlyNa,
      surfaces: ["sdk"],
      harnesses: ["codex"],
    });
    expect(plan.status).toBe("empty");
    expect(plan.cells).toEqual([]);
    expect(plan.skipped_surfaces).toEqual([{ surface: "sdk", reason: "no-executable-tasks" }]);
  });

  it("does not schedule undeclared non-API surfaces", () => {
    const plan = buildLowPassExecutionPlan({
      suiteName: "suite",
      standardSetVersion: "suite-v1",
      vendor: "acme",
      pack: pack(),
      surfaces: ["mcp"],
      harnesses: ["codex"],
    });
    expect(plan.status).toBe("empty");
    expect(plan.skipped_surfaces).toEqual([{ surface: "mcp", reason: "surface-not-configured" }]);
  });

  it("rejects identity mismatches, duplicates, unsafe names, and invalid surfaces", () => {
    const base = {
      suiteName: "suite",
      standardSetVersion: "suite-v1",
      vendor: "acme",
      pack: pack(),
      surfaces: ["api" as const],
      harnesses: ["codex"],
    };
    expect(() => buildLowPassExecutionPlan({ ...base, vendor: "other" })).toThrow(/does not match pack/);
    expect(() => buildLowPassExecutionPlan({ ...base, standardSetVersion: "suite-v2" })).toThrow(/does not match pack/);
    expect(() => buildLowPassExecutionPlan({ ...base, harnesses: ["codex", "codex"] })).toThrow(/must be unique/);
    expect(() => buildLowPassExecutionPlan({ ...base, suiteName: " " })).toThrow(/must not be empty/);
    expect(() => buildLowPassExecutionPlan({ ...base, surfaces: ["web" as "api"] })).toThrow(/invalid surface/);

    const unverifiable = pack();
    unverifiable.tasks[0]!.oracles = [];
    expect(() => buildLowPassExecutionPlan({ ...base, pack: unverifiable })).toThrow(/without oracles: shared/);
  });
});
