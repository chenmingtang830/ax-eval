import { dirname, isAbsolute, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { GeneratedReportSnapshot } from "./snapshot.js";
import { tasksForSurface, type SurfaceId } from "../surface/index.js";
import type { TargetPack } from "../schemas.js";
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

export function daebPackPath(root: string, vendor: string, _suitePath: string): string {
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
