/**
 * Compact OpenAPI operation inventory for seeding capability extraction.
 *
 * ax-eval's `ingest` (openapi.ts) produces an opinionated CRUD view tuned for
 * simple REST — it deliberately pairs create/read endpoints and drops anything
 * that doesn't fit that shape. For seeding the benchmark capability inventory
 * we instead want the RAW operation list (every method+path with its summary),
 * so the LLM judges the full documented surface — including non-CRUD operations
 * like backups, functions, or replication that the CRUD view discards.
 *
 * The result is a plain-text block small enough to inline in a prompt: one line
 * per operation, grouped by tag, capped so a several-hundred-operation admin
 * API doesn't blow the context window.
 */
import { parse as yamlParse } from "yaml";
import { fetchSpecText, type IngestOptions } from "./run.js";

interface OperationRow {
  method: string;
  path: string;
  summary: string;
  tag: string;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

function collectOperations(spec: Record<string, unknown>): OperationRow[] {
  const paths = (spec.paths ?? {}) as Record<string, unknown>;
  const rows: OperationRow[] = [];
  for (const [path, itemRaw] of Object.entries(paths)) {
    if (!itemRaw || typeof itemRaw !== "object") continue;
    const item = itemRaw as Record<string, unknown>;
    for (const method of HTTP_METHODS) {
      const opRaw = item[method];
      if (!opRaw || typeof opRaw !== "object") continue;
      const op = opRaw as Record<string, unknown>;
      const summary =
        (typeof op.summary === "string" && op.summary) ||
        (typeof op.description === "string" && op.description.split("\n")[0]) ||
        (typeof op.operationId === "string" && op.operationId) ||
        "";
      const tags = Array.isArray(op.tags) ? (op.tags as unknown[]) : [];
      const tag = typeof tags[0] === "string" ? (tags[0] as string) : "untagged";
      rows.push({ method: method.toUpperCase(), path, summary: summary.trim().slice(0, 140), tag });
    }
  }
  return rows;
}

export interface SpecSummary {
  title: string;
  source: string;
  operationCount: number;
  /** Prompt-ready text: operations grouped by tag, capped. */
  text: string;
  truncated: boolean;
}

/** Parse OpenAPI (JSON or YAML) text into a compact operation inventory. */
export function summarizeOpenApiText(text: string, source: string, maxOps = 150): SpecSummary {
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(text) as Record<string, unknown>;
  } catch {
    spec = (yamlParse(text) ?? {}) as Record<string, unknown>;
  }
  const info = (spec.info ?? {}) as Record<string, unknown>;
  const title = typeof info.title === "string" ? info.title : source;
  const rows = collectOperations(spec);
  const truncated = rows.length > maxOps;
  const capped = rows.slice(0, maxOps);

  const byTag = new Map<string, OperationRow[]>();
  for (const row of capped) {
    const list = byTag.get(row.tag) ?? [];
    list.push(row);
    byTag.set(row.tag, list);
  }
  const lines: string[] = [];
  for (const [tag, ops] of [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${tag}`);
    for (const op of ops) lines.push(`- ${op.method} ${op.path}${op.summary ? ` — ${op.summary}` : ""}`);
  }
  if (truncated) lines.push(`… (${rows.length - maxOps} more operations omitted)`);

  return { title, source, operationCount: rows.length, text: lines.join("\n"), truncated };
}

/** Fetch an OpenAPI spec URL and summarize its operations for prompt seeding.
 *  Uses ingest's fetcher (offline fixture support + timeout). */
export async function fetchSpecSummary(url: string, opts: IngestOptions = {}): Promise<SpecSummary> {
  const { text, source } = await fetchSpecText(url, opts);
  return summarizeOpenApiText(text, source);
}
