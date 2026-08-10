import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import {
  checkCellApproval,
  loadPack,
  packFileContentHash,
  type NormalizedCellRecord,
  type SurfaceId,
  type TargetPack,
} from "ax-eval";
import { createDatabaseRuntimeExtensionRegistry } from "./index.js";
import {
  cellCredentialNames,
  cellResetCredentialNames,
  cellVerificationCredentialNames,
  executeArenaCell,
  type ArenaCellExecution,
} from "./controller/cell.js";

export const LOCAL_DATABASE_CALIBRATION_SCHEMA = "ax.axarena-local-calibration/v2" as const;
export const LOCAL_DATABASE_CALIBRATION_MODELS = {
  codex: "gpt-5.6-terra",
  "claude-code": "claude-sonnet-5",
} as const;

const VENDORS = ["cockroachdb", "insforge", "neon", "nile", "supabase", "turso"] as const;
const SURFACES = ["api", "cli"] as const;
const HARNESSES = ["codex", "claude-code"] as const;
const STRUCTURAL_NA: Readonly<Record<string, string>> = {
  "supabase/api": "admitted provisioning blocker: PostgREST cannot create the required tables, roles, and policies",
};

export function localDatabaseCalibrationCellKeys(): string[] {
  return VENDORS.flatMap((vendor) => SURFACES.flatMap((surface) => HARNESSES.map((harness) => `${vendor}/${surface}/${harness}/trial-1`)));
}

type HarnessId = (typeof HARNESSES)[number];
type CellStatus = "completed" | "failed" | "structural_na" | "cost_unknown" | "budget_exhausted";

export interface LocalDatabaseCalibrationOptions {
  root: string;
  runRoot: string;
  exportDir: string;
  credentials: Readonly<Record<string, string | undefined>>;
  budgetUsd?: number;
  now?: () => Date;
}

export interface LocalDatabaseCalibrationCell {
  key: string;
  vendor: string;
  surface: SurfaceId;
  harness: HarnessId;
  model: string;
  trial: 1;
  profile: "medium";
  status: CellStatus;
  tasks_total: number | null;
  tasks_passed: number | null;
  pass_at_1: number | null;
  total_duration_ms: number | null;
  cost_usd: number | null;
  cost_status: "measured" | "unknown" | "not_applicable";
  cleanup_status: string;
  reason: string | null;
  record_path: string | null;
  cleanup_path: string | null;
  evidence: { record: string; cleanup: string } | null;
  task_results: Array<{ id: string; success: boolean; na: boolean; error: string | null }>;
}

export interface LocalDatabaseCalibrationManifest {
  schema: typeof LOCAL_DATABASE_CALIBRATION_SCHEMA;
  warning: "LOCAL CALIBRATION · NOT FOR PUBLICATION OR RANKING";
  trust_level: "local";
  publication_eligible: false;
  generated_at: string;
  source_commit_sha: string;
  trial_count: 1;
  profile: "medium";
  harness_versions: Record<HarnessId, string>;
  budget_usd: number;
  measured_cost_usd: number;
  status: "completed" | "budget_exhausted";
  cells: LocalDatabaseCalibrationCell[];
}

function canonicalJson(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input)
    ? input.map(canonical)
    : input && typeof input === "object"
      ? Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]))
      : input;
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function requireInside(root: string, value: string, label: string): string {
  const absolute = resolve(value);
  const rel = relative(resolve(root), absolute);
  if (!rel || rel === ".." || rel.startsWith("../")) throw new Error(`${label} must be inside the repository root`);
  return absolute;
}

function cleanCommit(root: string): string {
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", "."], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (dirty) throw new Error("local database calibration requires a clean source tree");
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function harnessVersion(harness: HarnessId): string {
  const command = harness === "codex" ? "codex" : "claude";
  const output = execFileSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (!output) throw new Error(`${command} version probe returned no version`);
  return output;
}

function packFor(root: string, vendor: string): { path: string; pack: TargetPack } {
  const path = resolve(root, "ax-arena/benchmark/axarena-database/v1/packs", vendor, "pack.yaml");
  const pack = loadPack(path);
  const approval = checkCellApproval(pack, path, packFileContentHash(path));
  if (!approval.ok) throw new Error(`${vendor} pack is not approved: ${approval.reason ?? "unknown approval failure"}`);
  return { path, pack };
}

function requiredCredentialNames(pack: TargetPack, surface: SurfaceId, harness: HarnessId, credentials: Readonly<Record<string, string | undefined>>): string[] {
  return [...new Set([
    ...cellCredentialNames(pack, surface, harness, credentials),
    ...cellVerificationCredentialNames(pack, credentials, surface),
    ...cellResetCredentialNames(pack, credentials),
  ])].sort();
}

function codexManagedLoginAvailable(credentials: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(credentials.OPENAI_API_KEY?.trim()) || existsSync(resolve(homedir(), ".codex", "auth.json"));
}

function requireCredentials(credentials: Readonly<Record<string, string | undefined>>, names: readonly string[]): void {
  const missing = names.filter((name) => !credentials[name]?.trim());
  if (missing.length) throw new Error(`local database calibration is missing credential(s): ${missing.join(", ")}`);
}

function cellPaths(root: string, runRoot: string, vendor: string, surface: SurfaceId, harness: HarnessId): { artifactDir: string; recordPath: string; cleanupPath: string } {
  const cellDir = resolve(runRoot, "cells", vendor, surface, harness, "trial-1");
  const artifactDir = resolve(cellDir, "artifacts");
  return { artifactDir, recordPath: resolve(artifactDir, "record.normalized.json"), cleanupPath: resolve(artifactDir, "cleanup.json") };
}

function scanSecrets(root: string, paths: readonly string[], values: readonly string[]): void {
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`secret scan refuses symlink: ${path}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(resolve(path, entry));
      return;
    }
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) return;
    const text = bytes.toString("utf8");
    for (const value of values) if (value && text.includes(value)) throw new Error(`secret scan found a credential value in ${relative(root, path)}`);
  };
  for (const path of paths) if (existsSync(path)) visit(path);
}

function costFromRecord(record: NormalizedCellRecord): number | null {
  return typeof record.cost_usd === "number" && Number.isFinite(record.cost_usd) ? record.cost_usd : null;
}

function safeError(error: unknown, secrets: readonly string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.split(secret).join("<redacted>");
  return message.replaceAll(/[\r\n]/g, " ").slice(0, 2_000);
}

function completedCell(execution: ArenaCellExecution, root: string, vendor: string, surface: SurfaceId, harness: HarnessId, model: string): LocalDatabaseCalibrationCell {
  const cost = costFromRecord(execution.record);
  const recordPath = relative(root, execution.recordPath);
  const cleanupPath = relative(root, execution.cleanupPath);
  return {
    key: `${vendor}/${surface}/${harness}/trial-1`, vendor, surface, harness, model, trial: 1, profile: "medium",
    status: execution.cleanup.status === "confirmed" ? "completed" : "failed",
    tasks_total: execution.record.tasks_total, tasks_passed: execution.record.tasks_passed, pass_at_1: execution.record.pass_at_1,
    total_duration_ms: execution.record.total_duration_ms, cost_usd: cost,
    cost_status: cost === null ? "unknown" : "measured", cleanup_status: execution.cleanup.status,
    reason: execution.cleanup.status === "confirmed" ? null : "cleanup was not confirmed",
    record_path: recordPath, cleanup_path: cleanupPath, evidence: { record: recordPath, cleanup: cleanupPath },
    task_results: execution.record.task_results.map((task) => ({ id: task.taskId, success: task.success, na: task.na, error: task.error ?? null })),
  };
}

export function buildLocalDatabaseCalibrationManifest(options: {
  sourceCommitSha: string;
  generatedAt: string;
  budgetUsd: number;
  cells: LocalDatabaseCalibrationCell[];
  measuredCostUsd: number;
  harnessVersions?: Record<HarnessId, string>;
  status?: "completed" | "budget_exhausted";
}): LocalDatabaseCalibrationManifest {
  return {
    schema: LOCAL_DATABASE_CALIBRATION_SCHEMA,
    warning: "LOCAL CALIBRATION · NOT FOR PUBLICATION OR RANKING",
    trust_level: "local",
    publication_eligible: false,
    generated_at: options.generatedAt,
    source_commit_sha: options.sourceCommitSha,
    trial_count: 1,
    profile: "medium",
    harness_versions: options.harnessVersions ?? { codex: "unknown", "claude-code": "unknown" },
    budget_usd: options.budgetUsd,
    measured_cost_usd: options.measuredCostUsd,
    status: options.status ?? "completed",
    cells: options.cells,
  };
}

export function exportLocalDatabaseCalibration(options: {
  root: string;
  exportDir: string;
  manifest: LocalDatabaseCalibrationManifest;
  credentials: Readonly<Record<string, string | undefined>>;
}): void {
  const exportDir = requireInside(options.root, options.exportDir, "local database calibration export directory");
  if (existsSync(exportDir)) throw new Error("local database calibration export directory already exists");
  const payload = {
    ...options.manifest,
    integrity: { sha256: createHash("sha256").update(canonicalJson(options.manifest.cells)).digest("hex") },
  };
  const serialized = canonicalJson(payload);
  for (const value of Object.values(options.credentials)) {
    if (value?.trim() && serialized.includes(value.trim())) throw new Error("local database calibration export contains a credential value");
  }
  mkdirSync(exportDir, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(exportDir, "database-v1.json"), serialized, { mode: 0o600 });
}

export async function runLocalDatabaseCalibration(options: LocalDatabaseCalibrationOptions): Promise<LocalDatabaseCalibrationManifest> {
  const root = resolve(options.root);
  const runRoot = requireInside(root, options.runRoot, "local database calibration run directory");
  const exportDir = requireInside(root, options.exportDir, "local database calibration export directory");
  if (existsSync(runRoot)) throw new Error("local database calibration run directory already exists");
  const budgetUsd = options.budgetUsd ?? 50;
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error("local database calibration budget must be positive");
  const sourceCommitSha = cleanCommit(root);
  const packs = new Map(VENDORS.map((vendor) => [vendor, packFor(root, vendor)]));
  if (localDatabaseCalibrationCellKeys().length !== 24) throw new Error("local database calibration matrix must contain exactly 24 cells");
  const versions: Record<HarnessId, string> = {
    codex: harnessVersion("codex"),
    "claude-code": harnessVersion("claude-code"),
  };
  const credentialsByCell = new Map<string, Record<string, string | undefined>>();
  for (const vendor of VENDORS) for (const surface of SURFACES) for (const harness of HARNESSES) {
    const key = `${vendor}/${surface}/${harness}/trial-1`;
    if (STRUCTURAL_NA[`${vendor}/${surface}`]) continue;
    const pack = packs.get(vendor)!.pack;
    const names = requiredCredentialNames(pack, surface, harness, options.credentials);
    requireCredentials(options.credentials, names.filter((name) => name !== "OPENAI_API_KEY" || codexManagedLoginAvailable(options.credentials)));
    credentialsByCell.set(key, Object.fromEntries(names.map((name) => [name, options.credentials[name]])));
  }
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const now = options.now ?? (() => new Date());
  const batchId = `local-database-${now().toISOString().slice(0, 10)}-${sourceCommitSha.slice(0, 12)}`;
  const cells: LocalDatabaseCalibrationCell[] = [];
  let measuredCostUsd = 0;
  let budgetExhausted = false;
  for (const vendor of VENDORS) for (const surface of SURFACES) for (const harness of HARNESSES) {
    const key = `${vendor}/${surface}/${harness}/trial-1`;
    const model = LOCAL_DATABASE_CALIBRATION_MODELS[harness];
    const structuralReason = STRUCTURAL_NA[`${vendor}/${surface}`];
    if (structuralReason) {
      cells.push({ key, vendor, surface, harness, model, trial: 1, profile: "medium", status: "structural_na", tasks_total: null, tasks_passed: null, pass_at_1: null, total_duration_ms: null, cost_usd: null, cost_status: "not_applicable", cleanup_status: "not_run", reason: structuralReason, record_path: null, cleanup_path: null, evidence: null, task_results: [] });
      continue;
    }
    if (budgetExhausted) {
      cells.push({ key, vendor, surface, harness, model, trial: 1, profile: "medium", status: "budget_exhausted", tasks_total: null, tasks_passed: null, pass_at_1: null, total_duration_ms: null, cost_usd: null, cost_status: "unknown", cleanup_status: "not_run", reason: `measured cost reached the US$${budgetUsd} local cap`, record_path: null, cleanup_path: null, evidence: null, task_results: [] });
      continue;
    }
    const paths = cellPaths(root, runRoot, vendor, surface, harness);
    try {
      const execution = await executeArenaCell({
        cwd: root, ...paths, packPath: packs.get(vendor)!.path, batchId,
        evaluationSetId: "axarena-database-local-web-calibration", targetId: vendor, surface, harness,
        profile: "medium", model, effort: "medium", trial: 1, sourceCommitSha,
        invokeTimeoutMs: 1_800_000, firstActionTimeoutMs: 180_000, invokeRetries: 0, skipReset: false,
      }, {
        credentials: credentialsByCell.get(key)!,
        now, execution: { runtime_backend: "native", trust_level: "local" },
        createRegistry: async () => createDatabaseRuntimeExtensionRegistry(),
        allowAmbientHarnessAuth: harness === "codex" && codexManagedLoginAvailable(options.credentials),
      });
      const cell = completedCell(execution, root, vendor, surface, harness, model);
      cells.push(cell);
      scanSecrets(root, [paths.artifactDir], Object.values(credentialsByCell.get(key) ?? {}).filter((value): value is string => Boolean(value)));
      const cost = cell.cost_usd;
      if (cost !== null) {
        measuredCostUsd += cost;
        if (measuredCostUsd >= budgetUsd) budgetExhausted = true;
      }
    } catch (error) {
      const cellSecrets = Object.values(credentialsByCell.get(key) ?? {}).filter((value): value is string => Boolean(value));
      const reason = safeError(error, cellSecrets);
      try { scanSecrets(root, [paths.artifactDir], cellSecrets); } catch (scanError) {
        cells.push({ key, vendor, surface, harness, model, trial: 1, profile: "medium", status: "failed", tasks_total: null, tasks_passed: null, pass_at_1: null, total_duration_ms: null, cost_usd: null, cost_status: "unknown", cleanup_status: "unconfirmed", reason: safeError(scanError, cellSecrets), record_path: null, cleanup_path: null, evidence: null, task_results: [] });
        continue;
      }
      cells.push({ key, vendor, surface, harness, model, trial: 1, profile: "medium", status: "failed", tasks_total: null, tasks_passed: null, pass_at_1: null, total_duration_ms: null, cost_usd: null, cost_status: "unknown", cleanup_status: "unconfirmed", reason, record_path: existsSync(paths.recordPath) ? relative(root, paths.recordPath) : null, cleanup_path: existsSync(paths.cleanupPath) ? relative(root, paths.cleanupPath) : null, evidence: existsSync(paths.recordPath) && existsSync(paths.cleanupPath) ? { record: relative(root, paths.recordPath), cleanup: relative(root, paths.cleanupPath) } : null, task_results: [] });
    }
  }
  const manifest = buildLocalDatabaseCalibrationManifest({ sourceCommitSha, generatedAt: now().toISOString(), budgetUsd, cells, measuredCostUsd, harnessVersions: versions, status: budgetExhausted ? "budget_exhausted" : "completed" });
  writeFileSync(resolve(runRoot, "local-database-calibration-manifest.json"), canonicalJson(manifest), { mode: 0o600 });
  exportLocalDatabaseCalibration({ root, exportDir, manifest, credentials: options.credentials });
  return manifest;
}
