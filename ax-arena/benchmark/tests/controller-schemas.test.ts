import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  ArenaBatchCompletionSchema,
  ArenaBatchManifestSchema,
  ArenaCellCleanupSchema,
  arenaBatchConfigurationHash,
  type ArenaBatchConfiguration,
} from "../src/controller/schemas.js";

function shippedSchema(name = "arena-cell-cleanup.v1.json"): Record<string, unknown> {
  return JSON.parse(readFileSync(
    resolve(process.cwd(), "schemas", name),
    "utf8",
  ));
}

describe("arena cell cleanup schema", () => {
  it("ships a strict JSON schema for persisted cleanup evidence", () => {
    const schema = shippedSchema() as { additionalProperties: boolean; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining([
      "schema",
      "cell_id",
      "record_path",
      "record_sha256",
      "status",
      "message",
      "errors",
    ]));
  });

  it("keeps the runtime contract strict", () => {
    const cleanup = ArenaCellCleanupSchema.parse({
      schema: "ax.arena-cell-cleanup/v1",
      cell_id: "cell-1",
      record_path: "/run/record.json",
      record_sha256: "0".repeat(64),
      generated_at: "2026-07-21T00:00:01.000Z",
      status: "skipped",
      message: "test",
      errors: [],
    });
    expect(cleanup.status).toBe("skipped");
    expect(ArenaCellCleanupSchema.safeParse({ ...cleanup, unknown: true }).success).toBe(false);
    expect(ArenaCellCleanupSchema.safeParse({ ...cleanup, cell_id: "   " }).success).toBe(false);
    expect(ArenaCellCleanupSchema.safeParse({ ...cleanup, record_sha256: "short" }).success).toBe(false);
  });

  it("rejects evidence-free confirmed cleanup in both runtime and published schemas", () => {
    const invalid = {
      schema: "ax.arena-cell-cleanup/v1",
      cell_id: "cell-1",
      record_path: "/run/record.json",
      record_sha256: "0".repeat(64),
      generated_at: "2026-07-21T00:00:01.000Z",
      status: "confirmed",
      message: "claimed cleanup",
      errors: [],
    };
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(shippedSchema());
    expect(ArenaCellCleanupSchema.safeParse(invalid).success).toBe(false);
    expect(validate(invalid)).toBe(false);

    const valid = {
      ...invalid,
      provider: { id: "reset", version: "1.0.0" },
      namespace: "cell-ns",
      plan: { summary: "one", resources: ["resource:cell-ns"] },
      evidence: {
        supported: true,
        message: "deleted",
        deleted: ["resource:cell-ns"],
        errors: [],
      },
    };
    expect(ArenaCellCleanupSchema.safeParse(valid).success).toBe(true);
    expect(validate(valid)).toBe(true);
    expect(ArenaCellCleanupSchema.safeParse({
      ...valid,
      evidence: { ...valid.evidence, deleted: ["resource:other"] },
    }).success).toBe(false);
  });
});

describe("arena batch schemas", () => {
  it("ships strict runtime-compatible manifest and completion contracts", () => {
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validateManifest = ajv.compile(shippedSchema("arena-batch.v1.json"));
    const validateCompletion = ajv.compile(shippedSchema("arena-batch-completion.v1.json"));
    const configuration: ArenaBatchConfiguration = {
      command: "daeb-low-pass",
      suite: { name: "DAEB-1", version: 1, file_hash: "1".repeat(64) },
      packs: [{
        vendor: "neon",
        file_hash: "3".repeat(64),
        standard_set_version: "database-v1",
        surfaces: ["api"],
        host_credential_names: ["OPENAI_API_KEY"],
        verification_credential_names: ["DATABASE_URL"],
        reset_credential_names: ["DATABASE_URL"],
        sandbox_scope_names: [],
      }],
      cells: [{
        key: "neon/api/codex/trial-1",
        vendor: "neon",
        surface: "api",
        harness: "codex",
        profile: "medium",
        effort: "medium",
        model: "model-codex",
        trial: 1,
        host_credential_names: ["OPENAI_API_KEY"],
        verification_credential_names: ["DATABASE_URL"],
        reset_credential_names: ["DATABASE_URL"],
        sandbox_scope_names: [],
      }],
      harnesses: [{ harness: "codex", version_raw: "codex 1.2.3", version_semver: "1.2.3" }],
      reset_required: false,
      invoke_timeout_seconds: 900,
      first_action_timeout_seconds: 180,
      invoke_retries: 0,
    };
    const manifest = {
      schema: "ax.arena-batch/v1",
      batch_id: "batch-1",
      source_commit_sha: "a".repeat(40),
      created_at: "2026-07-21T00:00:00.000Z",
      configuration_hash: arenaBatchConfigurationHash(configuration),
      configuration,
      expected_cells: ["neon/api/codex/trial-1"],
    };
    const completion = {
      schema: "ax.arena-batch-completion/v1",
      batch_id: "batch-1",
      source_commit_sha: "a".repeat(40),
      configuration_hash: arenaBatchConfigurationHash(configuration),
      completed_at: "2026-07-21T00:00:01.000Z",
      cells: [{
        key: "neon/api/codex/trial-1",
        record_id: "record-codex",
        record_path: "neon/api/codex/trial-1/record.json",
        record_hash: "4".repeat(64),
        cleanup_path: "neon/api/codex/trial-1/cleanup.json",
        cleanup_hash: "5".repeat(64),
        harness: "codex",
        requested_model: "model-codex",
        actual_model: "model-codex",
        harness_version_raw: "codex 1.2.3",
        harness_version_semver: "1.2.3",
        status: "completed",
        cleanup_status: "confirmed",
      }],
    };
    expect(ArenaBatchManifestSchema.safeParse(manifest).success).toBe(true);
    expect(validateManifest(manifest)).toBe(true);
    expect(ArenaBatchCompletionSchema.safeParse(completion).success).toBe(true);
    expect(validateCompletion(completion)).toBe(true);
    expect(validateManifest({ ...manifest, unknown: true })).toBe(false);
    expect(validateManifest({ ...manifest, created_at: "2026-07-21T01:00:00+01:00" })).toBe(false);
    expect(ArenaBatchManifestSchema.safeParse({ ...manifest, created_at: "2026-07-21T01:00:00+01:00" }).success).toBe(false);
    expect(validateCompletion({ ...completion, cells: [{ status: "failed" }] })).toBe(false);
    const structurallyValidButSemanticallyForged = {
      ...manifest,
      expected_cells: ["different/cell"],
    };
    expect(validateManifest(structurallyValidButSemanticallyForged)).toBe(true);
    expect(ArenaBatchManifestSchema.safeParse(structurallyValidButSemanticallyForged).success).toBe(false);
  });
});
