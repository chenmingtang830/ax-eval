/** Local JSON result storage. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunReport } from "./runner.js";

export function saveReport(report: RunReport, path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

export function loadReport(path: string): RunReport {
  return JSON.parse(readFileSync(path, "utf8")) as RunReport;
}
