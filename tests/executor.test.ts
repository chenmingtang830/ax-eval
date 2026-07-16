import { describe, expect, it } from "vitest";
import { applyNs, buildExecutorPrompt, resolveNs, taskResultKeys } from "../src/harness/executor.js";
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

  it("includes extra context ids in the required results shape when a task oracle needs them", () => {
    const extraPack = TargetPackSchema.parse({
      ...pack,
      tasks: [
        {
          id: "page-task",
          difficulty: "L2",
          prompt: 'Create a page "AX probe page {ns}" and report gid/docId.',
          allowed_surfaces: ["api", "docs"],
          create_path: "/docs/{docId}/pages",
          oracles: [{ type: "roundtrip", readPathTemplate: "/docs/{docId}/pages/{gid}", assertField: "name", expected: "AX probe page {ns}" }],
        },
      ],
    });
    const extraPrompt = buildExecutorPrompt({
      pack: extraPack,
      profile: getProfile("floor"),
      ns: "demo-floor-ab12",
      resultsPath: "results/run-floor.json",
      tracePath: "results/run-floor.trace.json",
    });
    expect(extraPrompt).toContain('"page-task": {"gid": "<gid or null>", "docId": "<docId or null>"}');
    expect(extraPrompt).toContain("extra context ids");
  });

  it("tells the executor to keep created ids even when read-after-write is temporarily unavailable", () => {
    expect(prompt).toContain("still record the created id");
    expect(prompt).toContain("202/404/409");
  });

  it("uses declared process env vars without instructing the executor to read .env", () => {
    expect(prompt).toContain("process.env.ASANA_PAT");
    expect(prompt).toContain("Never open, print, cat, grep, echo");
    expect(prompt).not.toContain("Read .env");
  });

  it("protects pre-existing resources and keeps task failures independent", () => {
    expect(prompt).toContain("Do not delete, reset, overwrite, or mutate pre-existing resources");
    expect(prompt).toContain("record a failed task and continue");
  });

  it("supports task subsets with reusable discovery context", () => {
    const subsetPrompt = buildExecutorPrompt({
      pack,
      profile: getProfile("floor"),
      ns: "demo-floor-ab12",
      resultsPath: "results/task.json",
      tracePath: "results/task.trace.json",
      tasks: [pack.tasks[0]!],
      sharedDiscovery: {
        path: "results/bootstrap.json",
        base_url_found: "https://example.test/api",
        endpoint_used: "POST /tasks",
      },
    });

    expect(subsetPrompt).toContain("SHARED BOOTSTRAP (already completed)");
    expect(subsetPrompt).toContain("results/bootstrap.json");
    expect(subsetPrompt).toContain("gen-l1-tasks");
    expect(subsetPrompt).not.toContain("gen-l3-tasks");
    expect(subsetPrompt).toContain("whether the task succeeded or failed");
  });

  it("keeps bootstrap-only runs free of task execution instructions", () => {
    const bootstrapPrompt = buildExecutorPrompt({
      pack,
      profile: getProfile("floor"),
      ns: "demo-floor-ab12",
      resultsPath: "results/bootstrap.json",
      tracePath: "results/bootstrap.trace.json",
      tasks: [],
    });

    expect(bootstrapPrompt).toContain("SHARED BOOTSTRAP OUTPUT");
    expect(bootstrapPrompt).toContain("Do not create benchmark resources");
    expect(bootstrapPrompt).not.toContain("For each task capture");
    expect(bootstrapPrompt).not.toContain("record a failed task and continue");
  });

  it("collects nested non-secret oracle placeholders and excludes credential-shaped fields", () => {
    const task = TargetPackSchema.parse({
      name: "database-demo",
      tasks: [{
        id: "database-task",
        prompt: "Create a searchable record.",
        create_path: "/projects/{project_id}/records",
        oracles: [
          {
            type: "roundtrip",
            readMethod: "POST",
            readPathTemplate: "/projects/{project_id}/search",
            readBodyTemplate: { collection: "{collection_name}", bearer_token: "{bearer_token}", mascot: "{monkey_id}" },
          },
          {
            type: "roundtrip",
            sqlDialect: "postgres",
            sqlQuery: "SELECT * FROM {table_name} WHERE id = '{gid}'",
          },
          {
            type: "roundtrip",
            mongoQuery: {
              database: "demo",
              collection: "{mongo_collection}",
              operation: "findOne",
              filter: { tenant: "{tenant_id}" },
            },
          },
        ],
      }],
    }).tasks[0]!;

    expect(taskResultKeys(task)).toEqual([
      "gid",
      "project_id",
      "collection_name",
      "monkey_id",
      "table_name",
      "mongo_collection",
      "tenant_id",
    ]);
  });
});
