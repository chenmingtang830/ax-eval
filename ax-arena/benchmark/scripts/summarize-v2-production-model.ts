import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadPack, packContentHash } from "ax-eval";

const ROOT = resolve(import.meta.dirname, "../../..");
const BATCH = process.env.DAEB_V2_BATCH;
if (!BATCH) throw new Error("DAEB_V2_BATCH is required");
const HARNESS = process.env.DAEB_V2_HARNESS ?? "unknown";
const MODEL = process.env.DAEB_V2_MODEL ?? "unknown";
const VENDORS = (process.env.DAEB_V2_VENDORS ?? "cockroachdb,insforge,neon,nile")
  .split(",").map((value) => value.trim()).filter(Boolean);
const TRIALS = (process.env.DAEB_V2_TRIALS ?? "1,2,3")
  .split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const runRoot = resolve(ROOT, "results", BATCH);
const vendors = VENDORS.map((vendor) => {
  const packPath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2/production/packs", vendor, "pack.yaml");
  const approvalPath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2/production/packs", vendor, "pack.approval.json");
  const pack = loadPack(packPath);
  const approval = readJson<{ pack_file_hash?: string; content_hash?: string; standard_set_version?: string }>(approvalPath);
  const trials = TRIALS.map((trial) => {
    const auditPath = resolve(runRoot, vendor, `trial-${trial}`, "model-audit.json");
    if (!existsSync(auditPath)) throw new Error(`missing audit: ${auditPath}`);
    const audit = readJson<{
      vendor: string; harness: string; model: string; trial: number; surface: string;
      exec_plan_exit_code: number; summary: { runnable_tasks: number; oracle_passed: number; strict_passed: number; oracle_rate: number | null; strict_rate: number | null };
      task_audit: Array<{ task_id: string; na: boolean; gid_reported: boolean; oracle_passed: boolean; strict_passed: boolean }>;
      verify_error: string | null; cleanup: { evidence?: { errors?: string[] } } | { error?: string } | null;
    }>(auditPath);
    const cleanupErrors = audit.cleanup && "evidence" in audit.cleanup
      ? audit.cleanup.evidence?.errors ?? []
      : audit.cleanup && "error" in audit.cleanup ? [audit.cleanup.error ?? "cleanup error"] : [];
    return {
      trial,
      audit_path: auditPath.replace(`${ROOT}/`, ""),
      pack_name: pack.name,
      harness: audit.harness,
      model: audit.model,
      surface: audit.surface,
      exec_plan_exit_code: audit.exec_plan_exit_code,
      summary: audit.summary,
      task_audit: audit.task_audit,
      verify_error: audit.verify_error,
      cleanup_confirmed: cleanupErrors.length === 0,
      cleanup_errors: cleanupErrors,
    };
  });
  return {
    vendor,
    pack: {
      path: packPath.replace(`${ROOT}/`, ""),
      sha256: sha256(packPath),
      approval_pack_file_hash: approval.pack_file_hash ?? null,
      approval_content_hash: approval.content_hash ?? null,
      approval_matches_current_pack: sha256(packPath) === approval.pack_file_hash,
      content_hash_matches_approval: packContentHash(pack) === approval.content_hash,
      standard_set_version: pack.standard_set_version,
      task_count: pack.tasks.length,
      runnable_task_count: pack.tasks.filter((task) => !task.na).length,
      structural_na_task_ids: pack.tasks.filter((task) => task.na).map((task) => task.id),
    },
    trials,
  };
});

const allTrials = vendors.flatMap((vendor) => vendor.trials.map((trial) => ({ vendor: vendor.vendor, ...trial })));
const taskAudit = allTrials.flatMap((trial) => trial.task_audit.filter((task) => !task.na).map((task) => ({ vendor: trial.vendor, trial: trial.trial, ...task })));
const strictPassed = taskAudit.filter((task) => task.strict_passed).length;
const oraclePassed = taskAudit.filter((task) => task.oracle_passed).length;
const gids = taskAudit.filter((task) => task.gid_reported).length;
const report = {
  schema: "ax.daeb-v2-production-model-audit/v2",
  generated_at: new Date().toISOString(),
  execution_scope: {
    trust_level: "local",
    harness: HARNESS,
    model: MODEL,
    route: HARNESS === "opencode" ? `OpenCode -> ${MODEL}` : `${HARNESS} -> ${MODEL}`,
    surface: "cli",
    vendors: VENDORS,
    trials: TRIALS,
  },
  vendors,
  aggregate: {
    vendor_count: vendors.length,
    trial_count: allTrials.length,
    task_trial_observations: taskAudit.length,
    gid_reported: gids,
    oracle_passed: oraclePassed,
    strict_passed: strictPassed,
    oracle_rate: taskAudit.length ? oraclePassed / taskAudit.length : null,
    strict_rate: taskAudit.length ? strictPassed / taskAudit.length : null,
    all_trials_present: allTrials.length === VENDORS.length * TRIALS.length,
    all_exec_plans_zero: allTrials.every((trial) => trial.exec_plan_exit_code === 0),
    provider_oracle_errors: allTrials.filter((trial) => trial.verify_error).map((trial) => ({ vendor: trial.vendor, trial: trial.trial, error: trial.verify_error })),
    all_pack_approvals_match: vendors.every((vendor) => vendor.pack.approval_matches_current_pack && vendor.pack.content_hash_matches_approval),
    cleanup_confirmed: allTrials.every((trial) => trial.cleanup_confirmed),
  },
  publication_boundary: {
    local_cohort_is_not_official_publication_evidence: true,
    required_before_official_publication: [
      "committed immutable configuration source",
      "pinned OCI runtime",
      "hosted-trusted execution",
      "detached GitHub OIDC attestation",
      "official sealed production-rerun batch and publication bundle gates",
    ],
  },
};
writeFileSync(resolve(runRoot, "oracle-audit.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report.aggregate, null, 2));
