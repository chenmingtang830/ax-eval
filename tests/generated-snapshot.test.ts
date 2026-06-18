import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TargetPackSchema } from "../src/schemas.js";
import {
  GENERATED_REPORT_SNAPSHOT_SCHEMA,
  loadGeneratedReportSnapshot,
  renderGeneratedSnapshot,
  saveGeneratedReportSnapshot,
  type GeneratedReportSnapshot,
} from "../src/generate/snapshot.js";

function sampleSnapshot(): GeneratedReportSnapshot {
  const pack = TargetPackSchema.parse({
    name: "demo-generated",
    base_url: "https://api.example.test",
    standard_set_version: "gen-test",
    run_id: "run-test",
    generated_by: "deterministic@no-model",
    tasks: [
      {
        id: "task-1",
        title: "Task 1",
        prompt: "Create the thing",
        difficulty: "L1",
        allowed_surfaces: ["api"],
        oracles: [{ type: "roundtrip", readPathTemplate: "/items/{gid}", assertField: "name", expected: "Thing" }],
      },
    ],
  });
  return {
    schema: GENERATED_REPORT_SNAPSHOT_SCHEMA,
    pack,
    runs: [
      {
        profile: "low",
        harness: "codex",
        model: "host-default",
        surface: "api",
        outcomes: [
          {
            taskId: "task-1",
            difficulty: "L1",
            profile: "low",
            success: true,
            oracleResults: [{ type: "roundtrip", passed: true, detail: "name=\"Thing\"" }],
            error: null,
          },
        ],
        discovery: {
          hops: 1,
          metrics: [
            { id: "official", passed: true, detail: "ok" },
            { id: "canonical", passed: true, detail: "ok" },
            { id: "misled", passed: true, detail: "ok" },
            { id: "auth", passed: true, detail: "ok" },
          ],
        },
        evidence: {
          results: ["/tmp/run.json"],
        },
      },
    ],
    staticReadiness: {
      site: "https://docs.example.test",
      v0Score: 80,
      v2Score: 70,
    },
    harness: {
      host: "codex",
      hostLabel: "OpenAI Codex",
      model: "gpt-5.5",
      confidence: "high",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      detectedAt: new Date().toISOString(),
      signals: ["CODEX_HOME"],
      suggestion: {
        profiles: ["gpt5"],
        matrix: false,
        reason: "test",
      },
    },
    warnings: ["snapshot warning"],
    minPassRate: 0.8,
  };
}

describe("generated report snapshots", () => {
  it("saves, loads, and re-renders a generated report snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "ax-eval-snapshot-"));
    const path = join(dir, "generated-eval.snapshot.json");
    const snapshot = sampleSnapshot();
    saveGeneratedReportSnapshot(path, snapshot);

    const loaded = loadGeneratedReportSnapshot(path);
    expect(loaded.schema).toBe(GENERATED_REPORT_SNAPSHOT_SCHEMA);
    expect(readFileSync(path, "utf8")).toContain('"schema": "ax.generated-report-snapshot/v1"');

    const html = renderGeneratedSnapshot(loaded);
    expect(html).toContain("How well can an AI agent use");
    expect(html).toContain("Discovery");
    expect(html).toContain("Execution");
    expect(html).toContain("snapshot warning");
  });
});
