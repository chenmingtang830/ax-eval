import {
  BUBBLEWRAP_POLICY_VERSION,
  BUBBLEWRAP_RUNTIME_ROOTS,
} from "./sandbox.js";
import { buildBatchPlan } from "./batch.js";
import {
  ArenaBatchManifestSchema,
  ArenaBatchPlanSchema,
  arenaExecutionMode,
  type ArenaBatchManifest,
  type ArenaBatchPlan,
} from "./schemas.js";

export interface TrustedWorkflowMatrixCell {
  cell_key: string;
  artifact_name: string;
  environment_name: string;
  runtime_manifest_name: string;
}

export interface TrustedWorkflowDispatch {
  batch_id: string;
  configuration_source: string;
  configuration_sha256: string;
  matrix: { include: TrustedWorkflowMatrixCell[] };
}

const TRUSTED_WORKFLOW_MAX_CELLS = 256;

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildTrustedWorkflowDispatch(
  batch: ArenaBatchManifest,
  plan: ArenaBatchPlan,
): TrustedWorkflowDispatch {
  const parsedBatch = ArenaBatchManifestSchema.parse(batch);
  const parsedPlan = ArenaBatchPlanSchema.parse(plan);
  if (!exactJson(parsedPlan, buildBatchPlan(parsedBatch))) {
    throw new Error("trusted workflow requires the exact immutable plan derived from its batch");
  }
  if (parsedPlan.cells.some((cell) => cell.surface !== "api" && cell.surface !== "cli")) {
    throw new Error("trusted workflow supports only reviewed API and CLI cells");
  }
  if (parsedPlan.cells.length > TRUSTED_WORKFLOW_MAX_CELLS) {
    throw new Error(`trusted workflow supports at most ${TRUSTED_WORKFLOW_MAX_CELLS} matrix cells`);
  }
  const source = parsedBatch.configuration_source;
  if (!source) throw new Error("trusted workflow requires a committed configuration source attestation");
  if (!parsedBatch.configuration.reset_required || parsedPlan.cells.some((cell) => !cell.reset_required)) {
    throw new Error("trusted workflow requires confirmed cleanup for every cell");
  }
  const execution = arenaExecutionMode(parsedBatch.configuration);
  if (execution.runtime_backend !== "pinned-oci" || execution.trust_level !== "hosted-trusted") {
    throw new Error("trusted workflow requires pinned-oci + hosted-trusted execution");
  }
  const sandbox = parsedBatch.configuration.sandbox;
  if (!sandbox
    || sandbox.policy_version !== BUBBLEWRAP_POLICY_VERSION
    || sandbox.sysroot !== "/opt/ax-arena-runtime/rootfs"
    || sandbox.executable !== "/opt/ax-arena-tools/bubblewrap/usr/bin/bwrap"
    || !exactJson(sandbox.runtime_roots, [...BUBBLEWRAP_RUNTIME_ROOTS])) {
    throw new Error("trusted workflow requires the reviewed OCI and Bubblewrap v2 policy");
  }
  if (parsedPlan.cells.some((cell) => !exactJson(cell.execution, execution)
    || !exactJson(cell.sandbox, sandbox))) {
    throw new Error("trusted workflow cell descriptors must retain the exact runtime and sandbox pins");
  }

  const matrix = parsedPlan.cells.map((cell) => {
    const suffix = `${cell.vendor}-${cell.surface}-${cell.harness}-trial-${cell.trial}`;
    return {
      cell_key: cell.key,
      artifact_name: `trusted-cell-${suffix}`,
      environment_name: `trusted-sandbox-${suffix}`,
      runtime_manifest_name: `runtime-manifest-${suffix}.json`,
    };
  });
  for (const field of ["artifact_name", "environment_name", "runtime_manifest_name"] as const) {
    if (new Set(matrix.map((cell) => cell[field])).size !== matrix.length) {
      throw new Error(`trusted workflow cell ${field.replaceAll("_", " ")} values must be unique`);
    }
  }
  return {
    batch_id: parsedBatch.batch_id,
    configuration_source: source.path,
    configuration_sha256: source.file_hash,
    matrix: { include: matrix },
  };
}
