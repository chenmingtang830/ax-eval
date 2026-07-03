import { describe, expect, it } from "vitest";
import { applyNs, buildExecutorPrompt, resolveNs } from "../src/harness/executor.js";
import { getProfile } from "../src/harness/profile.js";
import { TargetPackSchema } from "../src/schemas.js";

const pack = TargetPackSchema.parse({
  name: "asana-generated",
  run_id: "2026-06-02-joaufx",
  base_url: "https://app.asana.com/api/1.0",
  tasks: [
    {
      id: "gen-l1-tasks",
      difficulty: "L1",
      prompt: `Using the API (POST /tasks), create a task name="AX probe tasks {ns}".`,
      allowed_surfaces: ["api", "docs"],
      oracles: [{ type: "roundtrip", readPathTemplate: "/tasks/{gid}", assertField: "name", expected: "AX probe tasks {ns}" }],
    },
    {
      id: "gen-l3-tasks",
      difficulty: "L3",
      prompt: `Register a task "AX probe tasks-goal {ns}" using only docs.`,
      allowed_surfaces: ["docs"],
      oracles: [{ type: "roundtrip", readPathTemplate: "/tasks/{gid}", assertField: "name", expected: "AX probe tasks-goal {ns}" }],
    },
  ],
});

describe("namespace", () => {
  it("resolveNs is unique per call and embeds version + profile", () => {
    const a = resolveNs("2026-06-02-joaufx", "floor");
    const b = resolveNs("2026-06-02-joaufx", "floor");
    expect(a).not.toEqual(b);
    expect(a).toContain("joaufx");
    expect(a).toContain("floor");
  });

  it("applyNs replaces every {ns}", () => {
    expect(applyNs("a {ns} b {ns}", "X")).toBe("a X b X");
  });
});

describe("buildExecutorPrompt", () => {
  const prompt = buildExecutorPrompt({
    pack,
    profile: getProfile("floor"),
    ns: "joaufx-floor-ab12",
    resultsPath: "results/run-floor.json",
    tracePath: "results/run-floor.trace.json",
  });

  it("substitutes ns into task names (no {ns} left)", () => {
    expect(prompt).toContain("AX probe tasks joaufx-floor-ab12");
    expect(prompt).not.toContain("{ns}");
  });

  it("runs discovery as Phase 0 (cold start) before the tasks", () => {
    expect(prompt).toMatch(/PHASE 0 — DISCOVERY/);
    expect(prompt).toMatch(/WEB SEARCH/);
    const phase0 = prompt.indexOf("PHASE 0");
    const phase1 = prompt.indexOf("PHASE 1");
    expect(phase0).toBeGreaterThanOrEqual(0);
    expect(phase1).toBeGreaterThan(phase0);
  });

  it("requires a combined results file (discovery funnel + tasks) and a trace file", () => {
    expect(prompt).toContain("results/run-floor.json");
    expect(prompt).toContain("results/run-floor.trace.json");
    expect(prompt).toContain('"ns": "joaufx-floor-ab12"');
    expect(prompt).toContain('"discovery"');
    expect(prompt).toContain('"searches"');
  });

  it("carries the profile effort budget", () => {
    expect(prompt).toContain("LOW-EFFORT");
    expect(prompt).toMatch(/~40 API actions/);
  });

  it("can scope the prompt to a single canonical task", () => {
    const single = buildExecutorPrompt({
      pack,
      profile: getProfile("floor"),
      ns: "joaufx-floor-ab12",
      resultsPath: "results/run-floor-gen-l1-tasks.json",
      tracePath: "results/run-floor-gen-l1-tasks.trace.json",
      tasks: [pack.tasks[0]!],
    });
    expect(single).toContain("THIS ONE TASK");
    expect(single).toContain("gen-l1-tasks");
    expect(single).not.toContain("gen-l3-tasks");
    expect(single).toContain("whether the task succeeded or failed");
  });
});
