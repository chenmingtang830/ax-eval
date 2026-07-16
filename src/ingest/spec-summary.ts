import { parseDocument } from "yaml";
import { fetchSpecText, type IngestOptions } from "./run.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

interface OperationRow {
  method: string;
  path: string;
  summary: string;
  tag: string;
}

export interface SpecSummary {
  title: string;
  source: string;
  operationCount: number;
  text: string;
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function singleLine(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function parseSpec(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const document = parseDocument(text);
    if (document.errors.length > 0) throw new Error("OpenAPI document is not valid JSON or YAML");
    value = document.toJS();
  }
  if (!isRecord(value)) throw new Error("OpenAPI document root must be an object");
  return value;
}

function operationSummary(operation: Record<string, unknown>): string {
  if (typeof operation.summary === "string" && operation.summary.trim()) return singleLine(operation.summary, 140);
  if (typeof operation.description === "string" && operation.description.trim()) return singleLine(operation.description, 140);
  if (typeof operation.operationId === "string" && operation.operationId.trim()) return singleLine(operation.operationId, 140);
  return "";
}

function collectOperations(spec: Record<string, unknown>): OperationRow[] {
  if (spec.paths === undefined) return [];
  if (!isRecord(spec.paths)) throw new Error("OpenAPI paths must be an object");
  const rows: OperationRow[] = [];
  for (const [rawPath, itemValue] of Object.entries(spec.paths)) {
    if (!isRecord(itemValue)) continue;
    const path = singleLine(rawPath, 240);
    for (const method of HTTP_METHODS) {
      const operation = itemValue[method];
      if (!isRecord(operation)) continue;
      const tags = Array.isArray(operation.tags) ? operation.tags : [];
      const tag = typeof tags[0] === "string" && tags[0].trim()
        ? singleLine(tags[0], 80)
        : "untagged";
      rows.push({ method: method.toUpperCase(), path, summary: operationSummary(operation), tag });
    }
  }
  return rows.sort((left, right) =>
    left.tag.localeCompare(right.tag)
    || left.path.localeCompare(right.path)
    || left.method.localeCompare(right.method));
}

export function summarizeOpenApiText(text: string, source: string, maxOperations = 150): SpecSummary {
  if (!Number.isInteger(maxOperations) || maxOperations < 1) {
    throw new Error("maxOperations must be a positive integer");
  }
  const spec = parseSpec(text);
  const info = isRecord(spec.info) ? spec.info : {};
  const title = typeof info.title === "string" && info.title.trim()
    ? singleLine(info.title, 160)
    : source;
  const operations = collectOperations(spec);
  const capped = operations.slice(0, maxOperations);
  const byTag = new Map<string, OperationRow[]>();
  for (const operation of capped) {
    byTag.set(operation.tag, [...(byTag.get(operation.tag) ?? []), operation]);
  }
  const lines: string[] = [];
  for (const [tag, taggedOperations] of byTag) {
    lines.push(`[tag ${JSON.stringify(tag)}]`);
    for (const operation of taggedOperations) {
      lines.push([
        `- method=${operation.method}`,
        `path=${JSON.stringify(operation.path)}`,
        ...(operation.summary ? [`summary=${JSON.stringify(operation.summary)}`] : []),
      ].join(" "));
    }
  }
  const truncated = operations.length > maxOperations;
  if (truncated) lines.push(`… (${operations.length - maxOperations} more operations omitted)`);
  return {
    title,
    source,
    operationCount: operations.length,
    text: lines.join("\n"),
    truncated,
  };
}

/** Fetch an OpenAPI document and summarize it for grounded capability extraction. */
export async function fetchSpecSummary(url: string, opts: IngestOptions = {}): Promise<SpecSummary> {
  const { text, source } = await fetchSpecText(url, opts);
  return summarizeOpenApiText(text, source);
}
