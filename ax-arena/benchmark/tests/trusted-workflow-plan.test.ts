import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBatchPlan, resolveBatchIdentity } from "../src/controller/batch.js";
import type { ArenaBatchConfiguration } from "../src/controller/schemas.js";
import { buildTrustedWorkflowDispatch } from "../src/controller/workflow.js";

function configuration(
  resetRequired = true,
  surface: ArenaBatchConfiguration["cells"][number]["surface"] = "api",
  vendorCount = 1,
  hosted = true,
): ArenaBatchConfiguration {
  const vendors = Array.from({ length: vendorCount }, (_, index) =>
    vendorCount === 1 ? "neon" : `vendor-${String(index + 1).padStart(3, "0")}`);
  const harnesses = ["codex", "claude-code"] as const;
  return {
    command: "daeb-low-pass",
    ...(hosted ? { execution: { runtime_backend: "pinned-oci" as const, trust_level: "hosted-trusted" as const } } : {}),
    suite: { name: "DAEB-1", version: 1, file_hash: "1".repeat(64) },
    packs: vendors.map((vendor) => ({
      vendor,
      file_hash: "2".repeat(64),
      standard_set_version: "database-v1",
      surfaces: [surface],
      host_credential_names: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SANDBOX_ID"],
      verification_credential_names: ["DATABASE_URL", "SANDBOX_ID"],
      reset_credential_names: ["DATABASE_URL"],
      sandbox_scope_names: ["SANDBOX_ID"],
    })),
    cells: vendors.flatMap((vendor) => harnesses.map((harness) => ({
      key: `${vendor}/${surface}/${harness}/trial-1`,
      vendor,
      surface,
      harness,
      profile: "medium" as const,
      effort: "medium" as const,
      model: harness === "codex" ? "model-codex" : "model-claude",
      trial: 1,
      host_credential_names: [harness === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY", "SANDBOX_ID"],
      verification_credential_names: ["DATABASE_URL", "SANDBOX_ID"],
      reset_credential_names: ["DATABASE_URL"],
      sandbox_scope_names: ["SANDBOX_ID"],
      provider_pins: [],
      reset_provider: { id: "reset", version: "1.0.0" },
    }))),
    harnesses: [
      { harness: "codex", version_raw: "codex 1.2.3", version_semver: "1.2.3" },
      { harness: "claude-code", version_raw: "claude 2.3.4", version_semver: "2.3.4" },
    ],
    reset_required: resetRequired,
    invoke_timeout_seconds: 900,
    first_action_timeout_seconds: 180,
    invoke_retries: 0,
    ...(hosted ? {
      sandbox: {
        kind: "bubblewrap" as const,
        policy_version: "ax.arena-bubblewrap/v2" as const,
        runtime_lock_sha256: "3".repeat(64),
        sysroot: "/opt/ax-arena-runtime/rootfs" as const,
        executable: "/opt/ax-arena-tools/bubblewrap/usr/bin/bwrap",
        executable_sha256: "4".repeat(64),
        runtime_roots: ["/usr", "/opt/ax-arena-tools"] as ["/usr", "/opt/ax-arena-tools"],
      },
    } : {}),
  };
}

function fixture(
  resetRequired = true,
  surface: ArenaBatchConfiguration["cells"][number]["surface"] = "api",
  vendorCount = 1,
  hosted = true,
) {
  const root = mkdtempSync(resolve(tmpdir(), "ax-arena-trusted-plan-"));
  const batch = resolveBatchIdentity(
    root,
    "a".repeat(40),
    new Date("2026-07-22T00:00:00.000Z"),
    configuration(resetRequired, surface, vendorCount, hosted),
    { path: "ax-arena/benchmark/daeb/v1/trusted-global.json", file_hash: "5".repeat(64) },
  );
  return { batch, plan: buildBatchPlan(batch) };
}

describe("trusted whole-benchmark workflow dispatch", () => {
  it("derives only safe per-cell routing from the immutable hosted plan", () => {
    const { batch, plan } = fixture();
    const dispatch = buildTrustedWorkflowDispatch(batch, plan);
    expect(dispatch).toMatchObject({
      batch_id: batch.batch_id,
      configuration_source: "ax-arena/benchmark/daeb/v1/trusted-global.json",
      configuration_sha256: "5".repeat(64),
    });
    expect(dispatch.matrix.include).toEqual([
      {
        cell_key: "neon/api/codex/trial-1",
        artifact_name: "trusted-cell-neon-api-codex-trial-1",
        environment_name: "trusted-sandbox-neon-api-codex-trial-1",
        runtime_manifest_name: "runtime-manifest-neon-api-codex-trial-1.json",
      },
      {
        cell_key: "neon/api/claude-code/trial-1",
        artifact_name: "trusted-cell-neon-api-claude-code-trial-1",
        environment_name: "trusted-sandbox-neon-api-claude-code-trial-1",
        runtime_manifest_name: "runtime-manifest-neon-api-claude-code-trial-1.json",
      },
    ]);
    expect(JSON.stringify(dispatch)).not.toContain("OPENAI_API_KEY");
    expect(JSON.stringify(dispatch)).not.toContain("DATABASE_URL");
  });

  it("rejects cleanup-optional, native, reordered, and unsupported hosted plans", () => {
    const optional = fixture(false);
    expect(() => buildTrustedWorkflowDispatch(optional.batch, optional.plan)).toThrow(/confirmed cleanup/);
    const native = fixture(true, "api", 1, false);
    expect(() => buildTrustedWorkflowDispatch(native.batch, native.plan)).toThrow(/pinned-oci \+ hosted-trusted/);
    const exact = fixture();
    expect(() => buildTrustedWorkflowDispatch(exact.batch, {
      ...exact.plan,
      expected_cells: [...exact.plan.expected_cells].reverse(),
      cells: [...exact.plan.cells].reverse(),
    })).toThrow(/exact immutable plan|ordered expected cell set/);
    for (const surface of ["sdk", "mcp"] as const) {
      const unsupported = fixture(true, surface);
      expect(() => buildTrustedWorkflowDispatch(unsupported.batch, unsupported.plan))
        .toThrow(/only reviewed API and CLI/);
    }
  });

  it("rejects a hosted matrix above 256 cells", () => {
    const oversized = fixture(true, "api", 129);
    expect(() => buildTrustedWorkflowDispatch(oversized.batch, oversized.plan))
      .toThrow(/at most 256 matrix cells/);
  });
});
