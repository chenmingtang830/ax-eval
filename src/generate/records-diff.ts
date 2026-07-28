import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  LEGACY_NORMALIZED_RESULT_SCHEMA,
  NORMALIZED_RESULT_SCHEMA,
  type NormalizedEffort,
  type NormalizedResult,
} from "./record.js";

type LegacyNormalizedResult = Omit<NormalizedResult, "schema" | "effort"> & {
  schema: typeof LEGACY_NORMALIZED_RESULT_SCHEMA;
  effort?: never;
};
type ComparableNormalizedResult = NormalizedResult | LegacyNormalizedResult;

export type RecordsDiffInput = string | ComparableNormalizedResult[];

function isNormalizedResult(value: unknown): value is ComparableNormalizedResult {
  const schema = value && typeof value === "object" ? (value as { schema?: unknown }).schema : undefined;
  return schema === NORMALIZED_RESULT_SCHEMA || schema === LEGACY_NORMALIZED_RESULT_SCHEMA;
}

function recordsFromJson(value: unknown): ComparableNormalizedResult[] {
  if (isNormalizedResult(value)) return [value];
  if (Array.isArray(value)) return value.filter(isNormalizedResult);
  if (value && typeof value === "object") {
    const records = (value as { records?: unknown }).records;
    if (Array.isArray(records)) return records.filter(isNormalizedResult);
  }
  return [];
}

/** Load public normalized records from a file or directory without reading raw
 * transcripts. Directories are walked recursively and non-record JSON is
 * ignored, which makes the command safe for a full production run root. */
export function loadNormalizedRecordsForDiff(path: string): ComparableNormalizedResult[] {
  if (!existsSync(path)) throw new Error(`records path does not exist: ${path}`);
  if (statSync(path).isFile()) {
    return recordsFromJson(JSON.parse(readFileSync(path, "utf8")) as unknown);
  }
  const records: ComparableNormalizedResult[] = [];
  const stack = [path];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", ".git", ".invoke-home"].includes(entry.name)) stack.push(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        records.push(...recordsFromJson(JSON.parse(readFileSync(absolute, "utf8")) as unknown));
      } catch {
        /* Ignore malformed/non-record JSON; the source path remains auditable. */
      }
    }
  }
  return records;
}

function recordEffort(record: ComparableNormalizedResult): NormalizedEffort | null {
  return record.schema === NORMALIZED_RESULT_SCHEMA ? record.effort : null;
}

function recordKey(record: ComparableNormalizedResult): string {
  return JSON.stringify([record.product, record.harness, record.surface, record.model, recordEffort(record)]);
}

function selectComparableRecords(records: ComparableNormalizedResult[]): Map<string, ComparableNormalizedResult> {
  const selected = new Map<string, ComparableNormalizedResult>();
  for (const record of records) {
    if (record.blocked) continue;
    const key = recordKey(record);
    const current = selected.get(key);
    if (!current || (record.summary_kind === "aggregate" && current.summary_kind !== "aggregate") ||
      (record.summary_kind === current.summary_kind && record.generated_at > current.generated_at)) {
      selected.set(key, record);
    }
  }
  return selected;
}

function rate(value: number | null | undefined): string {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "—";
}

function number(value: number | null | undefined, digits = 0): string {
  return typeof value === "number" ? value.toFixed(digits) : "—";
}

function delta(base: number | null | undefined, head: number | null | undefined): string {
  if (typeof base !== "number" || typeof head !== "number") return "—";
  const value = (head - base) * 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)} pp`;
}

function pass3(record: ComparableNormalizedResult | undefined): string {
  if (!record || typeof record.task_consistency_at_3 !== "number") return "—";
  const count = record.pass_3_tasks;
  const total = record.pass_3_tasks_total;
  const exact = typeof count === "number" && typeof total === "number" ? ` (${count}/${total})` : "";
  return `${rate(record.task_consistency_at_3)}${exact}`;
}

function tokens(record: ComparableNormalizedResult | undefined): number | null {
  if (!record?.token_usage) return null;
  if (typeof record.token_usage.total_tokens === "number") return record.token_usage.total_tokens;
  return (record.token_usage.input_tokens ?? 0) + (record.token_usage.output_tokens ?? 0);
}

function correctnessRegressions(
  baseRecords: Map<string, ComparableNormalizedResult>,
  headRecords: Map<string, ComparableNormalizedResult>,
): string[] {
  const regressions: string[] = [];
  const epsilon = 1e-12;
  for (const [key, base] of baseRecords) {
    const head = headRecords.get(key);
    const label = `\`${base.product} / ${base.harness} / ${base.model ?? "unknown-model"} / ${recordEffort(base) ?? "unknown-effort"} / ${base.surface}\``;
    if (!head) {
      regressions.push(`${label}: baseline cell disappeared or became blocked.`);
      continue;
    }
    if (head.pass_at_1 < base.pass_at_1 - epsilon) {
      regressions.push(`${label}: pass@1 ${rate(base.pass_at_1)} → ${rate(head.pass_at_1)} (${delta(base.pass_at_1, head.pass_at_1)}).`);
    }
    if (typeof base.task_consistency_at_3 === "number" &&
      (typeof head.task_consistency_at_3 !== "number" || head.task_consistency_at_3 < base.task_consistency_at_3 - epsilon)) {
      regressions.push(`${label}: pass³ ${rate(base.task_consistency_at_3)} → ${rate(head.task_consistency_at_3)} (${delta(base.task_consistency_at_3, head.task_consistency_at_3)}).`);
    }
  }
  return regressions;
}

interface OverallRow {
  product: string;
  harness: string;
  model: string | null;
  effort: NormalizedEffort | null;
  score: number;
  pass3: number | null;
  pass3Count: number | null;
  pass3Total: number | null;
  surfaceCount: number;
}

function overallRows(records: Map<string, ComparableNormalizedResult>): Map<string, OverallRow> {
  const grouped = new Map<string, ComparableNormalizedResult[]>();
  for (const record of records.values()) {
    const key = JSON.stringify([record.product, record.harness, record.model, recordEffort(record)]);
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  return new Map([...grouped.entries()].map(([key, cells]) => {
    const countsAvailable = cells.every((cell) => typeof cell.pass_3_tasks === "number" && typeof cell.pass_3_tasks_total === "number");
    const pass3Count = countsAvailable ? cells.reduce((sum, cell) => sum + cell.pass_3_tasks!, 0) : null;
    const pass3Total = countsAvailable ? cells.reduce((sum, cell) => sum + cell.pass_3_tasks_total!, 0) : null;
    return [key, {
      product: cells[0]!.product,
      harness: cells[0]!.harness,
      model: cells[0]!.model,
      effort: recordEffort(cells[0]!),
      score: cells.reduce((sum, cell) => sum + cell.pass_at_1, 0) / cells.length,
      pass3: pass3Count !== null && pass3Total ? pass3Count / pass3Total : null,
      pass3Count,
      pass3Total,
      surfaceCount: cells.length,
    }];
  }));
}

function overallPass3(row: OverallRow | undefined): string {
  if (!row || row.pass3 === null) return "—";
  return `${rate(row.pass3)} (${row.pass3Count}/${row.pass3Total})`;
}

export function renderRecordsDiffMarkdown(baseInput: RecordsDiffInput, headInput: RecordsDiffInput): string {
  const baseRecords = selectComparableRecords(typeof baseInput === "string" ? loadNormalizedRecordsForDiff(baseInput) : baseInput);
  const headRecords = selectComparableRecords(typeof headInput === "string" ? loadNormalizedRecordsForDiff(headInput) : headInput);
  const baseOverall = overallRows(baseRecords);
  const headOverall = overallRows(headRecords);
  const overallKeys = [...new Set([...baseOverall.keys(), ...headOverall.keys()])].sort();
  const cellKeys = [...new Set([...baseRecords.keys(), ...headRecords.keys()])].sort();
  const regressions = correctnessRegressions(baseRecords, headRecords);
  const verdict = regressions.length
    ? [
        "## ❌ FAIL — Correctness regression detected",
        "",
        `Found ${regressions.length} regression signal(s) across ${baseRecords.size} baseline surface cell(s):`,
        "",
        ...regressions.map((regression) => `- ${regression}`),
      ]
    : [
        "## ✅ PASS — No correctness regression detected",
        "",
        `Compared ${baseRecords.size} baseline surface cell(s); no existing pass@1 or pass³ score decreased or disappeared.`,
      ];

  const overallTable = overallKeys.map((key) => {
    const base = baseOverall.get(key);
    const head = headOverall.get(key);
    const row = head ?? base!;
    return `| ${row.product} | ${row.harness} | ${row.model ?? "—"} | ${row.effort ?? "—"} | ${rate(base?.score)} | ${rate(head?.score)} | ${delta(base?.score, head?.score)} | ${overallPass3(base)} | ${overallPass3(head)} | ${head?.surfaceCount ?? base?.surfaceCount ?? 0} |`;
  });
  const cellsTable = cellKeys.map((key) => {
    const base = baseRecords.get(key);
    const head = headRecords.get(key);
    const row = head ?? base!;
    return `| ${row.product} | ${row.harness} | ${row.model ?? "—"} | ${recordEffort(row) ?? "—"} | ${row.surface} | ${rate(base?.pass_at_1)} | ${rate(head?.pass_at_1)} | ${delta(base?.pass_at_1, head?.pass_at_1)} | ${pass3(base)} | ${pass3(head)} | ${number(base?.latency_ms)} → ${number(head?.latency_ms)} | ${number(base?.cost_usd, 4)} → ${number(head?.cost_usd, 4)} | ${number(tokens(base))} → ${number(tokens(head))} | ${base?.harness_version_semver ?? "—"} → ${head?.harness_version_semver ?? "—"} |`;
  });

  return [
    "# Normalized records diff",
    "",
    ...verdict,
    "",
    "Overall is a macro-average of participating surface scores. Harness/model/effort configurations are never averaged together.",
    "",
    "## Overall by execution configuration",
    "",
    "| Product | Harness | Model | Effort | Base pass@1 | Head pass@1 | Δ | Base pass³ | Head pass³ | Surfaces |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(overallTable.length ? overallTable : ["| — | — | — | — | — | — | — | — | — | — |"]),
    "",
    "## Surface cells",
    "",
    "| Product | Harness | Model | Effort | Surface | Base pass@1 | Head pass@1 | Δ | Base pass³ | Head pass³ | Latency ms | Cost USD | Tokens | Harness version |",
    "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...(cellsTable.length ? cellsTable : ["| — | — | — | — | — | — | — | — | — | — | — | — | — | — |"]),
    "",
    "Operational metrics are context only and never affect the verdict or ranking.",
    "",
  ].join("\n");
}
