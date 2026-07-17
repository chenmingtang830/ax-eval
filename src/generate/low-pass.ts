import { dirname, isAbsolute, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { GeneratedReportSnapshot } from "./snapshot.js";
import { tasksForSurface, type SurfaceId } from "../surface/index.js";
import type { TargetPack } from "../schemas.js";
import type { ResetResult } from "../target/reset.js";
import { daebCompiledPackPath } from "./benchmark-paths.js";

export const DAEB_LOW_PASS_SCHEMA = "ax.low-coverage-pass/v1" as const;
export const DAEB_VENDOR_ORDER = [
  "neon",
  "cockroachdb",
  "turso",
  "supabase",
  "insforge",
  "nile",
] as const;
export const DAEB_V1_EXECUTION_SURFACES = ["api", "cli"] as const;

export interface LowPassSurfaceRecord {
  surface: SurfaceId;
  run_dir: string;
  result_paths: string[];
  html_report: string;
  snapshot_path: string;
  classification_path: string;
  namespaces: string[];
  verify_status?: "passed" | "failed";
  verify_error?: string;
  reset?: {
    performed: boolean;
    supported: boolean;
    message: string;
    errors: string[];
  };
}

export interface LowPassManifest {
  schema: typeof DAEB_LOW_PASS_SCHEMA;
  suite: string;
  vendor: string;
  generated_at: string;
  harnesses: string[];
  profile: "medium";
  execution_mode: "task";
  surfaces: LowPassSurfaceRecord[];
}

export interface LowPassLoadedResult<T extends { ns?: string } = { ns?: string }> {
  path: string;
  result?: T;
  error?: string;
}

export function loadLowPassResults<T extends { ns?: string }>(
  paths: string[],
  load: (path: string) => T,
): LowPassLoadedResult<T>[] {
  return paths.map((path) => {
    try {
      return { path, result: load(path) };
    } catch (error) {
      return { path, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export async function cleanupLowPassResults<T extends { ns?: string }>(opts: {
  loadedResults: LowPassLoadedResult<T>[];
  missingResultPaths: string[];
  skipReset: boolean;
  reset: (result: T) => Promise<ResetResult>;
}): Promise<NonNullable<LowPassSurfaceRecord["reset"]>> {
  if (opts.skipReset) {
    return { performed: false, supported: true, message: "skip-reset requested", errors: [] };
  }
  const results = await Promise.all(opts.loadedResults.map(async (loaded) => {
    if (loaded.error) {
      return {
        supported: false,
        message: `cannot parse ${loaded.path}: ${loaded.error}`,
        errors: [`unreadable result ${loaded.path}: ${loaded.error}`],
      };
    }
    if (!loaded.result?.ns) {
      return {
        supported: false,
        message: `no ns recorded in ${loaded.path}`,
        errors: [`missing result namespace for ${loaded.path}`],
      };
    }
    try {
      const resetResult = await opts.reset(loaded.result);
      return {
        supported: resetResult.supported && resetResult.errors.length === 0,
        message: resetResult.message,
        errors: resetResult.errors,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        supported: false,
        message: `reset ns=${loaded.result.ns} failed: ${message}`,
        errors: [message],
      };
    }
  }));
  return {
    performed: true,
    supported: opts.missingResultPaths.length === 0 && results.every((result) => result.supported),
    message: [
      ...results.map((result) => result.message),
      ...opts.missingResultPaths.map((path) => `missing result; cleanup cannot be confirmed for ${path}`),
    ].join(" | "),
    errors: [
      ...results.flatMap((result) => result.errors),
      ...opts.missingResultPaths.map((path) => `missing result namespace for ${path}`),
    ],
  };
}

export function lowPassSafetyIssues(opts: {
  invocationErrors: string[];
  missingResultPaths: string[];
  cleanupSupported: boolean;
  cleanupMessage: string;
  verifyError?: string;
  snapshotValid: boolean;
}): string[] {
  return [
    ...opts.invocationErrors.map((error) => `invocation failed: ${error}`),
    ...opts.missingResultPaths.map((path) => `missing result: ${path}`),
    ...(opts.cleanupSupported ? [] : [`cleanup unconfirmed: ${opts.cleanupMessage}`]),
    ...(!opts.snapshotValid && opts.verifyError ? [`verification artifact invalid: ${opts.verifyError}`] : []),
  ];
}

export function persistLowPassSurfaceOutcome(opts: {
  manifestPath: string;
  manifest: LowPassManifest;
  record: LowPassSurfaceRecord;
  safety: Parameters<typeof lowPassSafetyIssues>[0];
}): { manifest: LowPassManifest; unsafeReasons: string[] } {
  const manifest = upsertLowPassSurfaceRecord(opts.manifest, opts.record);
  writeFileSync(opts.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { manifest, unsafeReasons: lowPassSafetyIssues(opts.safety) };
}

export function upsertLowPassSurfaceRecord(
  manifest: LowPassManifest,
  record: LowPassSurfaceRecord,
): LowPassManifest {
  return {
    ...manifest,
    surfaces: [
      ...manifest.surfaces.filter((existing) => existing.surface !== record.surface),
      record,
    ].sort((left, right) => left.surface.localeCompare(right.surface)),
  };
}

export function daebVendorOrder(): string[] {
  return [...DAEB_VENDOR_ORDER];
}

export function daebPackPath(root: string, vendor: string): string {
  return daebCompiledPackPath(root, vendor);
}

export function daebFreshPackPath(runRoot: string, vendor: string, suitePath: string): string {
  const suiteStem = suitePath.replace(/^.*\//, "").replace(/\.yaml$/i, "");
  return resolve(runRoot, vendor, "_compiled", `${suiteStem}.yaml`);
}

export function supportedLowPassSurfaces(
  pack: TargetPack,
  selected?: SurfaceId,
  scope: readonly SurfaceId[] = DAEB_V1_EXECUTION_SURFACES,
): SurfaceId[] {
  const ordered: SurfaceId[] = [...scope];
  const candidates = selected ? [selected] : ordered;
  return candidates.filter((surface) => tasksForSurface(pack, surface).length > 0);
}

export function combinedResultPath(runDir: string, harness: "codex" | "claude-code", profile: string, surface: SurfaceId): string {
  const suffix = surface === "api" ? "" : `-${surface}`;
  return resolve(runDir, `run-${harness}-${profile}${suffix}.json`);
}

export function defaultLowPassRunRoot(root: string, runDir?: string): string {
  if (!runDir || runDir === "results") {
    return resolve(root, "results", "runs", "daeb-low-pass");
  }
  return resolve(root, runDir);
}

function initialFailureClassification(args: {
  validity: string;
  failedCount: number;
  failedDetails: string[];
}): string {
  if (args.failedCount === 0) return "passed-no-failure";
  const validity = args.validity.toLowerCase();
  const joined = args.failedDetails.join(" ").toLowerCase();
  if (validity.includes("timeout") || validity.includes("invoke_failed")) {
    return "agent-runtime-failure-needs-review";
  }
  if (joined.includes("quota") || joined.includes("rate limit") || joined.includes("too many")) {
    return "environment-failure-needs-review";
  }
  if (joined.includes("missing credential") || joined.includes("unauthorized") || joined.includes("forbidden")) {
    return "environment-auth-failure-needs-review";
  }
  return "agent-execution-failure-needs-review";
}

export function writeFailureClassificationStub(
  snapshot: GeneratedReportSnapshot,
  outPath: string,
  context: { vendor: string; surface: SurfaceId },
): void {
  mkdirSync(dirname(outPath), { recursive: true });
  const artifactDir = dirname(outPath);
  const absolutize = (value: string): string => (isAbsolute(value) ? value : resolve(artifactDir, value));
  const lines: string[] = [
    `# DAEB low-pass failure review`,
    ``,
    `vendor: ${context.vendor}`,
    `surface: ${context.surface}`,
    `generated_at: ${new Date().toISOString()}`,
    ``,
    `Review each harness cell before reset. Fill in the ` + "`classification`" + ` and notes fields if the automatic summary is insufficient.`,
    ``,
  ];
  for (const run of snapshot.runs) {
    const scored = run.outcomes.filter((outcome) => !outcome.na);
    const failed = scored.filter((outcome) => !outcome.success);
    const validity = run.efficiency?.validity_status ?? "valid";
    const failedDetails = failed.map((outcome) =>
      outcome.oracleResults
        .map((oracle) => oracle.detail)
        .join(" ") || outcome.error || "");
    lines.push(`## ${run.harness ?? "unknown"} / ${run.profile}`);
    lines.push(`- model: ${run.model ?? "unknown"}`);
    lines.push(`- validity_status: ${validity}`);
    lines.push(`- pass: ${scored.filter((outcome) => outcome.success).length}/${scored.length}`);
    lines.push(`- classification: ${initialFailureClassification({ validity, failedCount: failed.length, failedDetails })}`);
    if (run.evidence?.results?.length) lines.push(`- results: ${run.evidence.results.map(absolutize).join(", ")}`);
    if (run.evidence?.trace?.length) lines.push(`- trace: ${run.evidence.trace.map(absolutize).join(", ")}`);
    if (run.evidence?.transcript) lines.push(`- transcript: ${absolutize(run.evidence.transcript)}`);
    if (!failed.length) {
      lines.push(`- failed_tasks: none`);
    } else {
      lines.push(`- failed_tasks:`);
      for (const outcome of failed) {
        const detail = outcome.oracleResults
          .map((oracle) => `${oracle.passed ? "pass" : "fail"}:${oracle.detail}`)
          .join(" | ");
        lines.push(`  - ${outcome.taskId}: ${detail || outcome.error || "failed"}`);
      }
    }
    lines.push(`- notes:`);
    lines.push(``);
  }
  writeFileSync(outPath, lines.join("\n"));
}
