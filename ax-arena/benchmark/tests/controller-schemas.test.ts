import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  ArenaBatchCompletionSchema,
  ArenaBatchConfigurationSchema,
  ArenaBatchManifestSchema,
  ArenaExecutionModeSchema,
  ArenaCellCleanupSchema,
  ArenaRuntimeReportSchema,
  arenaBatchConfigurationHash,
  arenaExecutionMode,
  isPublicationEligibleExecutionMode,
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
  it("models runtime backends and trust levels without a pinned-to-native fallback", () => {
    expect(ArenaExecutionModeSchema.safeParse({
      runtime_backend: "native",
      trust_level: "hosted-trusted",
    }).success).toBe(false);
    expect(isPublicationEligibleExecutionMode({
      runtime_backend: "pinned-oci",
      trust_level: "hosted-trusted",
    })).toBe(true);
    expect(isPublicationEligibleExecutionMode({
      runtime_backend: "pinned-oci",
      trust_level: "local",
    })).toBe(false);

    const legacy = ArenaBatchConfigurationSchema.parse({
      command: "daeb-low-pass",
      suite: { name: "DAEB-1", version: 1, file_hash: "1".repeat(64) },
      packs: [{
        vendor: "neon", file_hash: "2".repeat(64), standard_set_version: "database-v1",
        surfaces: ["api"], host_credential_names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
        verification_credential_names: [], reset_credential_names: [], sandbox_scope_names: [],
      }],
      cells: [
        {
          key: "neon/api/codex/trial-1", vendor: "neon", surface: "api", harness: "codex",
          profile: "medium", effort: "medium", model: "model-codex", trial: 1,
          host_credential_names: ["OPENAI_API_KEY"], verification_credential_names: [],
          reset_credential_names: [], sandbox_scope_names: [], provider_pins: [], reset_provider: null,
        },
        {
          key: "neon/api/claude-code/trial-1", vendor: "neon", surface: "api", harness: "claude-code",
          profile: "medium", effort: "medium", model: "model-claude", trial: 1,
          host_credential_names: ["ANTHROPIC_API_KEY"], verification_credential_names: [],
          reset_credential_names: [], sandbox_scope_names: [], provider_pins: [], reset_provider: null,
        },
      ],
      harnesses: [
        { harness: "codex", version_raw: "codex 1.0.0", version_semver: "1.0.0" },
        { harness: "claude-code", version_raw: "claude 1.0.0", version_semver: "1.0.0" },
      ],
      reset_required: false,
      invoke_timeout_seconds: 1,
      first_action_timeout_seconds: 1,
      invoke_retries: 0,
    });
    expect(arenaExecutionMode(legacy)).toEqual({ runtime_backend: "native", trust_level: "local" });
    const sandbox = {
      kind: "bubblewrap",
      policy_version: "ax.arena-bubblewrap/v2",
      runtime_lock_sha256: "3".repeat(64),
      sysroot: "/opt/ax-arena-runtime/rootfs",
      executable: "/opt/ax-arena-tools/bubblewrap/usr/bin/bwrap",
      executable_sha256: "4".repeat(64),
      runtime_roots: ["/usr", "/opt/ax-arena-tools"],
    } as const;
    expect(ArenaBatchConfigurationSchema.safeParse({
      ...legacy,
      execution: { runtime_backend: "pinned-oci", trust_level: "local" },
    }).success).toBe(false);
    expect(ArenaBatchConfigurationSchema.safeParse({
      ...legacy,
      execution: { runtime_backend: "native", trust_level: "local" },
      sandbox,
    }).success).toBe(false);
    expect(ArenaBatchConfigurationSchema.safeParse({
      ...legacy,
      execution: { runtime_backend: "pinned-oci", trust_level: "local" },
      sandbox,
    }).success).toBe(true);
    expect(ArenaBatchConfigurationSchema.safeParse({
      ...legacy,
      execution: { runtime_backend: "pinned-oci", trust_level: "hosted-trusted" },
      sandbox,
    }).success).toBe(true);
  });

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
        host_credential_names: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
        verification_credential_names: ["DATABASE_URL"],
        reset_credential_names: ["DATABASE_URL"],
        sandbox_scope_names: [],
      }],
      cells: [
        {
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
          provider_pins: [],
          reset_provider: null,
        },
        {
          key: "neon/api/claude-code/trial-1",
          vendor: "neon",
          surface: "api",
          harness: "claude-code",
          profile: "medium",
          effort: "medium",
          model: "model-claude",
          trial: 1,
          host_credential_names: ["ANTHROPIC_API_KEY"],
          verification_credential_names: ["DATABASE_URL"],
          reset_credential_names: ["DATABASE_URL"],
          sandbox_scope_names: [],
          provider_pins: [],
          reset_provider: null,
        },
      ],
      harnesses: [
        { harness: "codex", version_raw: "codex 1.2.3", version_semver: "1.2.3" },
        { harness: "claude-code", version_raw: "claude-code 1.2.3", version_semver: "1.2.3" },
      ],
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
      expected_cells: ["neon/api/codex/trial-1", "neon/api/claude-code/trial-1"],
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
        artifacts: [
          { name: "invoke_metadata", path: "neon/api/codex/trial-1/artifacts/invoke.json", sha256: "6".repeat(64) },
          { name: "results", path: "neon/api/codex/trial-1/artifacts/results.json", sha256: "7".repeat(64) },
          { name: "trace", path: "neon/api/codex/trial-1/artifacts/trace.json", sha256: "8".repeat(64) },
          { name: "transcript", path: "neon/api/codex/trial-1/artifacts/transcript.jsonl", sha256: "9".repeat(64) },
        ],
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
    const shippedSandbox = {
      kind: "bubblewrap",
      policy_version: "ax.arena-bubblewrap/v2",
      runtime_lock_sha256: "a".repeat(64),
      sysroot: "/opt/ax-arena-runtime/rootfs",
      executable: "/opt/ax-arena-tools/bubblewrap/usr/bin/bwrap",
      executable_sha256: "b".repeat(64),
      runtime_roots: ["/usr", "/opt/ax-arena-tools"],
    };
    expect(validateManifest({
      ...manifest,
      configuration: {
        ...configuration,
        execution: { runtime_backend: "native", trust_level: "hosted-trusted" },
      },
    })).toBe(false);
    expect(validateManifest({
      ...manifest,
      configuration: {
        ...configuration,
        execution: { runtime_backend: "pinned-oci", trust_level: "local" },
      },
    })).toBe(false);
    expect(validateManifest({
      ...manifest,
      configuration: { ...configuration, sandbox: shippedSandbox },
    })).toBe(false);
    expect(validateManifest({
      ...manifest,
      configuration: {
        ...configuration,
        execution: { runtime_backend: "pinned-oci", trust_level: "hosted-trusted" },
        sandbox: shippedSandbox,
      },
    })).toBe(true);
    expect(ArenaBatchCompletionSchema.safeParse(completion).success).toBe(true);
    expect(validateCompletion(completion)).toBe(true);
    expect(validateManifest({ ...manifest, unknown: true })).toBe(false);
    expect(validateManifest({ ...manifest, created_at: "2026-07-21T01:00:00+01:00" })).toBe(false);
    expect(ArenaBatchManifestSchema.safeParse({ ...manifest, created_at: "2026-07-21T01:00:00+01:00" }).success).toBe(false);
    expect(validateCompletion({ ...completion, cells: [{ status: "failed" }] })).toBe(false);
    const structurallyValidButSemanticallyForged = {
      ...manifest,
      expected_cells: ["neon/api/codex/trial-2"],
    };
    expect(validateManifest(structurallyValidButSemanticallyForged)).toBe(true);
    expect(ArenaBatchManifestSchema.safeParse(structurallyValidButSemanticallyForged).success).toBe(false);
  });
});

describe("arena runtime report schema", () => {
  it("ships the strict persisted reporting manifest contract", () => {
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(shippedSchema("arena-runtime-report.v1.json"));
    const report = {
      schema: "ax.arena-runtime-report/v1",
      batch_id: "batch-1",
      configuration_hash: "a".repeat(64),
      source_commit_sha: "b".repeat(40),
      batch_manifest_sha256: "c".repeat(64),
      batch_completion_sha256: "d".repeat(64),
      execution: { runtime_backend: "native", trust_level: "local" },
      sandbox_provenance: null,
      generated_at: "2026-07-21T00:00:00.000Z",
      surface_reports: [{
        vendor: "neon",
        surface: "api",
        snapshot_path: "neon/api/reporting/generated-eval.snapshot.json",
        snapshot_sha256: "e".repeat(64),
        html_path: "neon/api/reporting/generated-eval.html",
        html_sha256: "f".repeat(64),
        failure_review_path: "neon/api/reporting/failure-review.md",
        failure_review_sha256: "0".repeat(64),
      }],
      aggregates: [{
        vendor: "neon",
        surface: "api",
        harness: "codex",
        trial_count: 1,
        aggregate_record_path: "neon/api/codex/aggregate/result.json",
        aggregate_record_sha256: "1".repeat(64),
        trial_manifest_path: "neon/api/codex/aggregate/trials.json",
        trial_manifest_sha256: "2".repeat(64),
      }],
    };
    expect(ArenaRuntimeReportSchema.safeParse(report).success).toBe(true);
    expect(validate(report)).toBe(true);
    const pinned = {
      ...report,
      execution: { runtime_backend: "pinned-oci", trust_level: "hosted-trusted" },
      sandbox_provenance: {
        id: "ax-arena-bubblewrap",
        version: "ax.arena-bubblewrap/v2",
        runtime_lock_sha256: "3".repeat(64),
        implementation_sha256: "4".repeat(64),
        policy_sha256: "5".repeat(64),
      },
    };
    expect(ArenaRuntimeReportSchema.safeParse(pinned).success).toBe(true);
    expect(validate(pinned)).toBe(true);
    expect(ArenaRuntimeReportSchema.safeParse({ ...report, source_commit_sha: undefined }).success).toBe(false);
    expect(validate({ ...report, source_commit_sha: undefined })).toBe(false);
    expect(ArenaRuntimeReportSchema.safeParse({ ...report, execution: pinned.execution }).success).toBe(false);
    expect(validate({ ...report, execution: pinned.execution })).toBe(false);
    expect(ArenaRuntimeReportSchema.safeParse({ ...pinned, sandbox_provenance: null }).success).toBe(false);
    expect(validate({ ...pinned, sandbox_provenance: null })).toBe(false);
    expect(ArenaRuntimeReportSchema.safeParse({ ...report, extra: true }).success).toBe(false);
    expect(validate({ ...report, extra: true })).toBe(false);
    for (const path of ["/absolute.json", "../escape.json", "nested/./ambiguous.json", "nested\\windows.json"]) {
      const invalid = {
        ...report,
        surface_reports: [{ ...report.surface_reports[0]!, snapshot_path: path }],
      };
      expect(ArenaRuntimeReportSchema.safeParse(invalid).success).toBe(false);
      expect(validate(invalid)).toBe(false);
    }
  });
});
