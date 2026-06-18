import { readFileSync, writeFileSync } from "node:fs";
import type { TargetPack } from "../schemas.js";
import type { HarnessProbe } from "../harness/probe.js";
import { renderGeneratedReport, type ProfileRun, type StaticReadiness } from "./report.js";

export const GENERATED_REPORT_SNAPSHOT_SCHEMA = "ax.generated-report-snapshot/v1" as const;

export interface GeneratedReportSnapshot {
  schema: typeof GENERATED_REPORT_SNAPSHOT_SCHEMA;
  pack: TargetPack;
  runs: ProfileRun[];
  staticReadiness?: StaticReadiness;
  harness: HarnessProbe;
  warnings: string[];
  minPassRate?: number;
}

export function saveGeneratedReportSnapshot(path: string, snapshot: GeneratedReportSnapshot): void {
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
}

export function loadGeneratedReportSnapshot(path: string): GeneratedReportSnapshot {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GeneratedReportSnapshot>;
  if (parsed?.schema !== GENERATED_REPORT_SNAPSHOT_SCHEMA) {
    throw new Error(`${path} is not an ${GENERATED_REPORT_SNAPSHOT_SCHEMA} snapshot`);
  }
  if (!parsed.pack || !Array.isArray(parsed.runs) || !parsed.harness) {
    throw new Error(`${path} is missing required generated-report snapshot fields`);
  }
  return {
    ...parsed,
    warnings: parsed.warnings ?? [],
  } as GeneratedReportSnapshot;
}

export function renderGeneratedSnapshot(snapshot: GeneratedReportSnapshot): string {
  return renderGeneratedReport(snapshot.pack, snapshot.runs, snapshot.staticReadiness, snapshot.harness, {
    gate: { minPassRate: snapshot.minPassRate },
    warnings: snapshot.warnings,
  });
}
