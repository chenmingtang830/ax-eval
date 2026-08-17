import "dotenv/config";

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadPack } from "ax-eval";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUTPUT = resolve(ROOT, "results/daeb-v2-production-local-audit-20260813.json");
const MODEL = "openrouter/z-ai/glm-5.2";

const cohort = {
  cockroachdb: [
    "results/daeb-v2-production-frozen-20260813/cockroachdb/trial-1",
    "results/daeb-v2-production-frozen-20260813/cockroachdb/trial-2",
    "results/daeb-v2-production-frozen-20260813-r2/cockroachdb/trial-3",
  ],
  insforge: [
    "results/daeb-v2-production-frozen-20260813-r3/insforge/trial-1",
    "results/daeb-v2-production-frozen-20260813-r3/insforge/trial-2",
    "results/daeb-v2-production-frozen-20260813-r4/insforge/trial-3",
  ],
  neon: [
    "results/daeb-v2-production-frozen-20260813-r2/neon/trial-1",
    "results/daeb-v2-production-frozen-20260813-r2/neon/trial-2",
    "results/daeb-v2-production-frozen-20260813-r2/neon/trial-3",
  ],
  nile: [
    "results/daeb-v2-production-frozen-20260813-r4/nile/trial-1",
    "results/daeb-v2-production-frozen-20260813-r4/nile/trial-2",
    "results/daeb-v2-production-frozen-20260813-r4/nile/trial-3",
  ],
  turso: [
    "results/daeb-v2-production-frozen-20260813-r5/turso/trial-1",
    "results/daeb-v2-production-frozen-20260813-r5/turso/trial-2",
    "results/daeb-v2-production-frozen-20260813-r5/turso/trial-3",
  ],
} as const;

type Audit = {
  vendor: string;
  trial: number;
  model: string;
  route: string;
  namespace: string | null;
  summary: { passed: number; eligible: number; rate: number | null };
  verifyError: string | null;
  cleanup: { evidence?: { deleted?: string[]; errors?: string[]; message?: string }; error?: string } | null;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function insforgeTrialTwoResidue(): Promise<string[]> {
  const { Client } = await import("pg");
  const connectionString = process.env.INSFORGE_CONNECTION_STRING;
  if (!connectionString) throw new Error("INSFORGE_CONNECTION_STRING is unavailable for cleanup recheck");
  const namespace = "d2p-ins-cli-opencode-high-t2";
  const roleNamespace = namespace.replaceAll("-", "_");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const tables = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE $1", [`axarena_%${namespace}`]);
    const functions = await client.query<{ proname: string }>("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE $1", [`axarena_%${namespace}`]);
    const roles = await client.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname LIKE $1", [`axarena_%${roleNamespace}`]);
    return [...tables.rows.map((row) => `table:${row.table_name}`), ...functions.rows.map((row) => `function:${row.proname}`), ...roles.rows.map((row) => `role:${row.rolname}`)];
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const vendors = [];
  let rawEligible = 0;
  let rawPassed = 0;
  for (const [vendor, trialDirs] of Object.entries(cohort)) {
    const packPath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2/production/packs", vendor, "pack.yaml");
    const approvalPath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2/production/packs", vendor, "pack.approval.json");
    const pack = loadPack(packPath);
    const approval = readJson<{ pack_file_hash: string; content_hash: string; approved_at: string }>(approvalPath);
    const runnableTaskIds = pack.tasks.filter((task) => !task.na).map((task) => task.id);
    const structuralNaTaskIds = pack.tasks.filter((task) => task.na).map((task) => task.id);
    const trials = trialDirs.map((relative) => {
      const dir = resolve(ROOT, relative);
      const auditPath = resolve(dir, "model-audit.json");
      const recordPath = resolve(dir, "run-opencode-high-cli.json");
      const tracePath = resolve(dir, "run-opencode-high-cli.trace.json");
      const audit = readJson<Audit>(auditPath);
      const record = readJson<{ model: string; harness: string; profile: string; surface: string; results: Record<string, unknown> }>(recordPath);
      const trace = readJson<unknown[]>(tracePath);
      const cleanupErrors = audit.cleanup?.evidence?.errors ?? [];
      const resultsTaskIds = Object.keys(record.results).sort();
      const expectedTaskIds = [...runnableTaskIds].sort();
      const checks = {
        audit_exists: existsSync(auditPath),
        record_exists: existsSync(recordPath),
        trace_exists: existsSync(tracePath) && trace.length > 0,
        route_matches: audit.route === "OpenCode -> OpenRouter -> z-ai/glm-5.2",
        model_matches: audit.model === MODEL && record.model === MODEL,
        harness_matches: record.harness === "opencode" && record.profile === "high" && record.surface === "cli",
        task_set_matches: JSON.stringify(resultsTaskIds) === JSON.stringify(expectedTaskIds),
        oracle_completed: audit.verifyError === null && audit.summary.eligible === runnableTaskIds.length,
        cleanup_confirmed: cleanupErrors.length === 0 && !audit.cleanup?.error,
      };
      rawEligible += audit.summary.eligible;
      rawPassed += audit.summary.passed;
      return { relative_dir: relative, audit, checks };
    });
    vendors.push({
      vendor,
      pack: {
        path: packPath.replace(`${ROOT}/`, ""),
        sha256: sha256(packPath),
        approval_file_hash: approval.pack_file_hash,
        approval_content_hash: approval.content_hash,
        approved_at: approval.approved_at,
        approval_matches_current_pack: sha256(packPath) === approval.pack_file_hash,
        total_tasks: pack.tasks.length,
        runnable_task_ids: runnableTaskIds,
        structural_na_task_ids: structuralNaTaskIds,
      },
      trials,
    });
  }
  const insforgeTrial2Residue = await insforgeTrialTwoResidue();
  const rawChecks = vendors.flatMap((vendor) => vendor.trials.flatMap((trial) => Object.entries(trial.checks).map(([name, value]) => ({ vendor: vendor.vendor, trial: trial.audit.trial, name, value }))));
  const cleanupException = vendors.find((vendor) => vendor.vendor === "insforge")?.trials.find((trial) => trial.audit.trial === 2);
  const report = {
    schema: "ax.arena-daeb-v2-local-cohort-audit/v1",
    generated_at: new Date().toISOString(),
    execution_scope: {
      trust_level: "local",
      route: "OpenCode -> OpenRouter -> z-ai/glm-5.2",
      surface: "cli",
      trials_per_vendor: 3,
      serial_within_vendor: true,
    },
    vendors,
    aggregate: {
      vendors: vendors.length,
      full_pack_tasks: vendors.reduce((sum, vendor) => sum + vendor.pack.total_tasks, 0),
      runnable_vendor_tasks: vendors.reduce((sum, vendor) => sum + vendor.pack.runnable_task_ids.length, 0),
      structural_na_vendor_tasks: vendors.reduce((sum, vendor) => sum + vendor.pack.structural_na_task_ids.length, 0),
      trial_observations: vendors.reduce((sum, vendor) => sum + vendor.trials.length, 0),
      raw_oracle_passed: rawPassed,
      raw_oracle_eligible: rawEligible,
      raw_oracle_rate: rawEligible ? rawPassed / rawEligible : null,
      all_pack_approvals_match: vendors.every((vendor) => vendor.pack.approval_matches_current_pack),
      all_raw_trial_checks_pass: rawChecks.every((check) => check.value),
      all_trial_checks_pass_after_remediation: rawChecks.every((check) => check.value || (check.vendor === "insforge" && check.trial === 2 && check.name === "cleanup_confirmed" && insforgeTrial2Residue.length === 0)),
      insforge_trial_2_raw_cleanup_errors: cleanupException?.audit.cleanup?.evidence?.errors ?? [],
      insforge_trial_2_post_remediation_residue: insforgeTrial2Residue,
      cleanup_confirmed_after_remediation: rawChecks.filter((check) => check.name === "cleanup_confirmed" && !check.value).every((check) => check.vendor === "insforge" && check.trial === 2) && insforgeTrial2Residue.length === 0,
    },
    publication_boundary: {
      local_cohort_is_not_official_publication_evidence: true,
      required_before_official_publication: [
        "committed immutable configuration source",
        "pinned OCI runtime",
        "hosted-trusted execution",
        "GitHub OIDC detached attestation",
        "official sealed production-rerun batch and publication bundle quality gates",
      ],
    },
  };
  mkdirSync(resolve(ROOT, "results"), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
  console.log(`${OUTPUT}\n${JSON.stringify(report.aggregate, null, 2)}`);
}

await main();
