#!/usr/bin/env node
/**
 * Local diagnostic recovery for the two unfinished K2.7 API cells.
 * This is deliberately not wired into production commands or publication.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  checkCellApproval,
  loadPack,
  packFileContentHash,
  type NormalizedCellRecord,
  type TargetPack,
} from "ax-eval";
import { createDatabaseRuntimeExtensionRegistry } from "../src/index.js";
import {
  cellCredentialNames,
  cellResetCredentialNames,
  cellVerificationCredentialNames,
  executeArenaCell,
  resolveSourceCommitSha,
} from "../src/controller/cell.js";

const MODEL = "moonshotai/kimi-k2.7-code";
const VENDORS = ["supabase", "nile"] as const;
const root = resolve(process.cwd());
const runRoot = process.argv[2]
  ? resolve(root, process.argv[2])
  : resolve(root, "results/runs/axarena-database-v1-repair-20260811/k27-api-v18");

function envFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (key && raw !== undefined) values[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireCredentials(credentials: Readonly<Record<string, string | undefined>>, names: readonly string[]): void {
  const missing = names.filter((name) => !credentials[name]?.trim());
  if (missing.length) throw new Error(`missing required credential(s): ${missing.join(", ")}`);
}

function packFor(vendor: typeof VENDORS[number]): { path: string; pack: TargetPack } {
  const path = resolve(root, "ax-arena/benchmark/axarena-database/v1/packs", vendor, "pack.yaml");
  const pack = loadPack(path);
  const approval = checkCellApproval(pack, path, packFileContentHash(path));
  if (!approval.ok) throw new Error(`${vendor} pack is not approved: ${approval.reason ?? "unknown approval failure"}`);
  return { path, pack };
}

function assertValidCell(record: NormalizedCellRecord, expectedVendor: string): void {
  if (record.harness !== "opencode" || record.model !== MODEL || record.target_id !== expectedVendor || record.surface !== "api") {
    throw new Error(`${expectedVendor} record identity does not match the requested K2.7 API cell`);
  }
  if (!record.task_results.length || record.tasks_total !== record.task_results.length) {
    throw new Error(`${expectedVendor} record has no complete task summary`);
  }
  if (!record.artifacts.trace) throw new Error(`${expectedVendor} record has no trace artifact`);
}

if (existsSync(runRoot)) throw new Error(`refusing to overwrite existing recovery run directory: ${runRoot}`);
const credentials = envFile(resolve(root, ".env"));
const sourceCommitSha = resolveSourceCommitSha(root);
const batchId = `k27-api-recovery-v18-${sourceCommitSha.slice(0, 12)}`;
const cells: Array<Record<string, unknown>> = [];

mkdirSync(runRoot, { recursive: true, mode: 0o700 });
for (const vendor of VENDORS) {
  const { path: packPath, pack } = packFor(vendor);
  const required = [...new Set([
    ...cellCredentialNames(pack, "api", "opencode", credentials, MODEL),
    ...cellVerificationCredentialNames(pack, credentials, "api"),
    ...cellResetCredentialNames(pack, credentials),
  ])].sort();
  requireCredentials(credentials, required);
  const cellRoot = resolve(runRoot, "cells", vendor, "api", "opencode", "trial-1");
  const artifactDir = resolve(cellRoot, "artifacts");
  const execution = await executeArenaCell({
    cwd: root,
    artifactDir,
    recordPath: resolve(artifactDir, "record.normalized.json"),
    cleanupPath: resolve(artifactDir, "cleanup.json"),
    packPath,
    batchId,
    evaluationSetId: "axarena-database-local-k27-api-recovery",
    targetId: vendor,
    surface: "api",
    harness: "opencode",
    profile: "medium",
    model: MODEL,
    effort: "medium",
    trial: 1,
    sourceCommitSha,
    invokeTimeoutMs: 1_800_000,
    firstActionTimeoutMs: 180_000,
    invokeRetries: 0,
    skipReset: false,
  }, {
    credentials,
    now: () => new Date(),
    execution: { runtime_backend: "native", trust_level: "local" },
    createRegistry: async () => createDatabaseRuntimeExtensionRegistry(),
  });
  assertValidCell(execution.record, vendor);
  cells.push({
    key: `${vendor}/api/opencode/trial-1`,
    status: execution.record.status,
    tasks_total: execution.record.tasks_total,
    tasks_passed: execution.record.tasks_passed,
    cleanup_status: execution.cleanup.status,
    record_path: relative(root, execution.recordPath),
    cleanup_path: relative(root, execution.cleanupPath),
  });
}

writeFileSync(resolve(runRoot, "recovery-manifest.json"), canonicalJson({
  schema: "ax.axarena-local-k27-api-recovery/v1",
  warning: "LOCAL DIAGNOSTIC · NOT FOR PUBLICATION OR RANKING",
  publication_eligible: false,
  batch_id: batchId,
  source_commit_sha: sourceCommitSha,
  harness: "opencode",
  model: MODEL,
  cells,
}), { mode: 0o600 });
console.log(JSON.stringify({ run_root: relative(root, runRoot), cells }));
