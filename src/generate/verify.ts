/**
 * Verify a generated pack's round-trip oracles against the live API.
 *
 * The executor (a clean subagent, per profile) performs the tasks and writes a
 * results file mapping task id -> { gid }. Verification is independent: we GET
 * the resource by id, strip the response envelope, and assert the field the
 * task set. Passing requires real API state, not the executor's self-report.
 */
import { readFileSync } from "node:fs";
import { BearerClient, HttpApiError, resolveDotted, type ApiStyle } from "../http/client.js";
import { applyNs, NS_PLACEHOLDER, type TraceStep } from "../harness/executor.js";
import type { SurfaceId } from "../surface/types.js";
import { tasksForSurface } from "../surface/index.js";
import type { DiscoveryResult } from "./discovery.js";
import type { OracleResult, OracleSpec, TargetPack, Task } from "../schemas.js";

export interface ExecutorResults {
  profile: string;
  /** Concrete harness/agent CLI that produced this result, when invoked by ax-eval. */
  harness?: string;
  /** The per-execution namespace this run used; substituted into {ns} oracles. */
  ns?: string;
  /** Which surface the agent operated the product through (api/cli/sdk/mcp).
   *  Self-described by the executor; the CLI's --surface flag overrides it. */
  surface?: string;
  /** Phase-0 discovery funnel this profile self-reported (behavioral AEO). */
  discovery?: DiscoveryResult;
  /** The model the harness ACTUALLY ran as (stamped from harness output by
   *  invoke.ts), not the profile's hardcoded label. undefined for older runs. */
  model?: string;
  /** task id -> reported ids (at least { gid }). */
  results: Record<string, { gid?: string } & Record<string, unknown>>;
}

export interface RoundtripOutcome {
  taskId: string;
  difficulty: string;
  profile: string;
  success: boolean;
  oracleResults: OracleResult[];
  error: string | null;
}

export function loadResults(path: string): ExecutorResults {
  return JSON.parse(readFileSync(path, "utf8")) as ExecutorResults;
}

/** Load a sibling *.trace.json if present (observability); empty if missing. */
export function loadTrace(path: string): TraceStep[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as TraceStep[]) : [];
  } catch {
    return [];
  }
}

/** Resolve {ns} in a string expected value; pass non-strings through. */
function resolveExpected(expected: unknown, ns: string | undefined): unknown {
  if (typeof expected === "string" && ns && expected.includes(NS_PLACEHOLDER)) {
    return applyNs(expected, ns);
  }
  return expected;
}

function resolveExpectedValues(oracle: OracleSpec, ns: string | undefined): unknown[] {
  return [oracle.expected, ...(oracle.expectedAny ?? [])].map((v) => resolveExpected(v, ns));
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    url.protocol = url.protocol.toLowerCase();
    let path = url.pathname.replace(/\/+$/, "");
    if (path.toLowerCase() === "/index.html" || path.toLowerCase() === "/overview.html") {
      path = path.replace(/\/[^/]+$/, "");
    }
    url.pathname = path || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/[#?].*$/, "").replace(/\/+$/, "");
  }
}

function valuesMatch(actual: unknown, expectedValues: unknown[], mode: OracleSpec["matchMode"]): boolean {
  if (mode === "url") {
    const normalizedActual = normalizeUrl(actual);
    return expectedValues.some((expected) => normalizedActual !== null && normalizedActual === normalizeUrl(expected));
  }
  return expectedValues.some((expected) => actual === expected);
}

function expectedDetail(expectedValues: unknown[]): string {
  return expectedValues.length === 1
    ? JSON.stringify(expectedValues[0])
    : `[${expectedValues.map((v) => JSON.stringify(v)).join(" | ")}]`;
}

function applyGidTemplate(value: unknown, gid: string): unknown {
  if (typeof value === "string") return value.split("{gid}").join(gid);
  if (Array.isArray(value)) return value.map((v) => applyGidTemplate(v, gid));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyGidTemplate(v, gid);
    }
    return out;
  }
  return value;
}

function extractTemplateParams(template: string, path: string): Record<string, string> | null {
  const tpl = template.split("/").filter(Boolean);
  const segs = path.split("?")[0]!.split("/").filter(Boolean);
  if (tpl.length !== segs.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < tpl.length; i += 1) {
    const t = tpl[i]!;
    const s = segs[i]!;
    const match = t.match(/^\{([^}]+)\}$/);
    if (match) {
      out[match[1]!] = decodeURIComponent(s);
      continue;
    }
    if (t !== s) return null;
  }
  return out;
}

function inferValueFromNote(note: string | undefined, name: string): string | undefined {
  if (!note) return undefined;
  const direct = note.match(new RegExp(`\\b${name}=([^\\s,;]+)`));
  if (direct?.[1]) return direct[1];
  const aliases: Record<string, RegExp[]> = {
    gid: [
      /\b(?:id|pageId|rowId|packId|folderId|requestId)=([^\s,;]+)/,
      /\b(?:doc|page|row|pack|folder)\s+([A-Za-z0-9_-]+)\b/,
    ],
    docId: [/\b(?:docId|doc)=([^\s,;]+)/, /\bdoc\s+([A-Za-z0-9_-]+)\b/],
    tableIdOrName: [/\b(?:tableIdOrName|tableId|table)=([^\s,;]+)/, /\btable\s+([A-Za-z0-9_-]+)\b/],
  };
  for (const pattern of aliases[name] ?? []) {
    const match = note.match(pattern);
    if (match?.[1]) return match[1];
  }
  if (name === "gid") {
    const generic = note.match(/\b([A-Za-z]+-[A-Za-z0-9_-]+|canvas-[A-Za-z0-9_-]+|grid-[A-Za-z0-9_-]+|i-[A-Za-z0-9_-]+|\d{4,})\b/);
    if (generic?.[1]) return generic[1];
  }
  return undefined;
}

function inferTemplateValue(
  task: Task,
  name: string,
  reported: ({ gid?: string } & Record<string, unknown>) | undefined,
  trace: TraceStep[],
  readPathTemplate: string,
): string | undefined {
  const direct = reported?.[name];
  if (typeof direct === "string" && direct) return direct;
  const readMatches = trace
    .filter((step) => step.taskId === task.id && typeof step.path === "string")
    .map((step) => extractTemplateParams(readPathTemplate, step.path!))
    .find((value): value is Record<string, string> => !!value?.[name]);
  if (readMatches?.[name]) return readMatches[name];
  const createMatches = task.create_path
    ? trace
        .filter((step) => step.taskId === task.id && typeof step.path === "string")
        .map((step) => extractTemplateParams(task.create_path!, step.path!))
        .find((value): value is Record<string, string> => !!value?.[name])
    : undefined;
  if (createMatches?.[name]) return createMatches[name];
  return [...trace]
    .filter((step) => step.taskId === task.id)
    .reverse()
    .map((step) => inferValueFromNote(step.note, name))
    .find((value): value is string => typeof value === "string" && value.length > 0);
}

function resolvePathTemplate(
  task: Task,
  readPathTemplate: string,
  reported: ({ gid?: string } & Record<string, unknown>) | undefined,
  trace: TraceStep[],
): { path?: string; missing?: string } {
  const placeholders = [...readPathTemplate.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  const replacements: Record<string, string> = {};
  for (const name of placeholders) {
    const value = inferTemplateValue(task, name, reported, trace, readPathTemplate);
    if (!value) return { missing: name };
    replacements[name] = value;
  }
  const path = readPathTemplate.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(replacements[name]!));
  return { path };
}

function listItems(body: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(body.items)) return body.items.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  if (Array.isArray(body.results)) return body.results.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  return [];
}

function hrefPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    return new URL(value).pathname;
  } catch {
    return undefined;
  }
}

async function readRoundtripFallback(
  client: BearerClient,
  path: string,
  oracle: OracleSpec,
  expectedValues: unknown[],
  gid: string,
): Promise<Record<string, unknown> | null> {
  const collectionPath = path.replace(/\/[^/]+$/, "");
  if (!collectionPath || collectionPath === path) return null;
  const listing = await client.get<Record<string, unknown>>(collectionPath);
  const items = listItems(listing);
  if (items.length === 0) return null;

  const byExpected = items.find((item) =>
    oracle.assertField
      ? valuesMatch(resolveDotted(item, oracle.assertField), expectedValues, oracle.matchMode)
      : false,
  );
  if (byExpected) return byExpected;

  const byId = items.find((item) => item.id === gid);
  if (byId) return byId;

  for (const item of items) {
    const itemPath = hrefPath(item.href);
    if (!itemPath || itemPath === path) continue;
    try {
      const fetched = await client.get<Record<string, unknown>>(itemPath);
      if (!oracle.assertField || valuesMatch(resolveDotted(fetched, oracle.assertField), expectedValues, oracle.matchMode)) {
        return fetched;
      }
    } catch {
      // Best-effort fallback only.
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRoundtripBody(
  client: BearerClient,
  path: string,
  oracle: OracleSpec,
  gid: string,
  fieldSelectParam: string | undefined,
): Promise<Record<string, unknown>> {
  const method = oracle.readMethod ?? "GET";
  let lastErr: unknown;
  const retryDelays = [0, 500, 1500, 3500, 7000];
  for (const delay of retryDelays) {
    if (delay > 0) await sleep(delay);
    try {
      return method === "POST"
        ? await client.post<Record<string, unknown>>(path, applyGidTemplate(oracle.readBodyTemplate, gid))
        : await client.get<Record<string, unknown>>(
            path,
            fieldSelectParam ? { [fieldSelectParam]: oracle.assertField! } : undefined,
          );
    } catch (err) {
      lastErr = err;
      if (!(err instanceof HttpApiError) || ![404, 409, 423].includes(err.status)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function verifyRoundtrip(
  task: Task,
  reported: { gid?: string } | undefined,
  client: BearerClient,
  ns: string | undefined,
  fieldSelectParam: string | undefined,
  apiStyle: ApiStyle,
  trace: TraceStep[],
): Promise<OracleResult[]> {
  const out: OracleResult[] = [];
  for (const oracle of task.oracles) {
    if (oracle.type !== "roundtrip") continue;
    const gid = inferTemplateValue(task, "gid", reported, trace, oracle.readPathTemplate ?? task.create_path ?? "{gid}");
    if (!gid) {
      out.push({ type: "roundtrip", passed: false, detail: "no gid reported by executor" });
      continue;
    }

    // GraphQL targets (Linear/Monday): substitute {gid} into the hand-authored
    // read-back query, POST it, and assert the dotted field against `data`.
    if (apiStyle === "graphql") {
      if (!oracle.readQueryTemplate || !oracle.assertField) {
        out.push({ type: "roundtrip", passed: false, detail: "oracle missing readQuery/assertField" });
        continue;
      }
      const query = oracle.readQueryTemplate.split("{gid}").join(gid);
      const expectedValues = resolveExpectedValues(oracle, ns);
      try {
        const data = await client.graphql<Record<string, unknown>>(query);
        const actual = resolveDotted(data, oracle.assertField);
        const passed = valuesMatch(actual, expectedValues, oracle.matchMode);
        out.push({
          type: "roundtrip",
          passed,
          detail: `${oracle.assertField}=${JSON.stringify(actual)} expected=${expectedDetail(expectedValues)}`,
        });
      } catch (err) {
        out.push({
          type: "roundtrip",
          passed: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    // REST targets (Asana/Notion/Exa): read back the path and assert the field.
    if (!oracle.readPathTemplate || !oracle.assertField) {
      out.push({ type: "roundtrip", passed: false, detail: "oracle missing readPath/assertField" });
      continue;
    }
    const { path, missing } = resolvePathTemplate(task, oracle.readPathTemplate, reported, trace);
    if (!path) {
      out.push({ type: "roundtrip", passed: false, detail: `oracle missing reported value for {${missing}}` });
      continue;
    }
    const expectedValues = resolveExpectedValues(oracle, ns);
    try {
      const body = await readRoundtripBody(client, path, oracle, gid, fieldSelectParam);
      const actual = resolveDotted(body, oracle.assertField);
      const passed = valuesMatch(actual, expectedValues, oracle.matchMode);
      out.push({
        type: "roundtrip",
        passed,
        detail: `${oracle.assertField}=${JSON.stringify(actual)} expected=${expectedDetail(expectedValues)}`,
      });
    } catch (err) {
      if (oracle.readMethod !== "POST" && err instanceof HttpApiError) {
        try {
          const fallback = await readRoundtripFallback(client, path, oracle, expectedValues, gid);
          if (fallback) {
            const actual = resolveDotted(fallback, oracle.assertField);
            const passed = valuesMatch(actual, expectedValues, oracle.matchMode);
            out.push({
              type: "roundtrip",
              passed,
              detail: `${oracle.assertField}=${JSON.stringify(actual)} expected=${expectedDetail(expectedValues)} (collection fallback)`,
            });
            continue;
          }
        } catch {
          // Keep the original error below.
        }
      }
      out.push({
        type: "roundtrip",
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export async function verifyGeneratedPack(
  pack: TargetPack,
  executor: ExecutorResults,
  client: BearerClient,
  surface?: SurfaceId,
  trace: TraceStep[] = [],
): Promise<RoundtripOutcome[]> {
  const outcomes: RoundtripOutcome[] = [];
  const tasks = surface ? tasksForSurface(pack, surface) : pack.tasks;
  for (const task of tasks) {
    const reported = executor.results[task.id];
    let oracleResults: OracleResult[];
    let error: string | null = null;
    try {
      oracleResults = await verifyRoundtrip(
        task,
        reported,
        client,
        executor.ns,
        pack.field_select_param,
        pack.api_style,
        trace,
      );
    } catch (err) {
      oracleResults = [];
      error = err instanceof Error ? err.message : String(err);
    }
    const success = oracleResults.length > 0 && oracleResults.every((r) => r.passed);
    outcomes.push({
      taskId: task.id,
      difficulty: task.difficulty,
      profile: executor.profile,
      success,
      oracleResults,
      error,
    });
  }
  return outcomes;
}
