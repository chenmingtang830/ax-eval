import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EVALUATION_CELL_SCHEMA,
  EvaluationCellSchema,
} from "../src/cell/schema.js";

function cell(): Record<string, unknown> {
  return {
    schema: EVALUATION_CELL_SCHEMA,
    cell_id: "batch-1-target-api-codex-t1",
    batch_id: "batch-1",
    evaluation_set_id: "example-set",
    evaluation_set_version: "example-v1",
    target_id: "example",
    pack: { path: "pack.yaml", content_hash: "0".repeat(64) },
    surface: "api",
    harness: { id: "codex", profile: "medium", model: "gpt-example", effort: "medium" },
    trial: 1,
    source_commit_sha: "a".repeat(40),
    required_credentials: ["EXAMPLE_TOKEN", "OPENAI_API_KEY"],
    run_context: {
      cwd: "/tmp/example",
      artifact_dir: "artifacts",
      invoke_timeout_ms: 10_000,
      first_action_timeout_ms: 1_000,
      invoke_retries: 0,
    },
  };
}

describe("evaluation cell schema", () => {
  it("requires every benchmark-controlled identity dimension", () => {
    expect(EvaluationCellSchema.parse(cell()).schema).toBe("ax.evaluation-cell/v1");
    for (const field of ["batch_id", "evaluation_set_id", "evaluation_set_version", "trial", "source_commit_sha"]) {
      const invalid = cell();
      delete invalid[field];
      expect(EvaluationCellSchema.safeParse(invalid).success, field).toBe(false);
    }
    for (const field of ["model", "effort"]) {
      const invalid = cell();
      delete (invalid.harness as Record<string, unknown>)[field];
      expect(EvaluationCellSchema.safeParse(invalid).success, `harness.${field}`).toBe(false);
    }
  });

  it("rejects matrix-shaped cells and ambiguous credential manifests", () => {
    expect(EvaluationCellSchema.safeParse({ ...cell(), surface: ["api", "cli"] }).success).toBe(false);
    expect(EvaluationCellSchema.safeParse({
      ...cell(),
      harness: [{ id: "codex", profile: "medium", model: "gpt-example", effort: "medium" }],
    }).success).toBe(false);
    expect(EvaluationCellSchema.safeParse({ ...cell(), trial: 0 }).success).toBe(false);
    expect(EvaluationCellSchema.safeParse({
      ...cell(),
      required_credentials: ["EXAMPLE_TOKEN", "EXAMPLE_TOKEN"],
    }).success).toBe(false);
  });

  it("ships separate strict schemas without widening legacy normalized-result/v1", () => {
    const input = JSON.parse(readFileSync(resolve("schemas/evaluation-cell.v1.json"), "utf8"));
    const output = JSON.parse(readFileSync(resolve("schemas/normalized-cell-record.v1.json"), "utf8"));
    const legacy = JSON.parse(readFileSync(resolve("schemas/normalized-result.v1.json"), "utf8"));
    expect(input.properties.schema.const).toBe("ax.evaluation-cell/v1");
    expect(output.properties.schema.const).toBe("ax.normalized-cell-record/v1");
    for (const field of ["cell_id", "batch_id", "evaluation_set_id", "pack_content_hash", "task_results"]) {
      expect(output.required).toContain(field);
    }
    expect(legacy.properties.schema.const).toBe("ax.normalized-result/v1");
    expect(legacy.properties).not.toHaveProperty("cell_id");
  });
});
