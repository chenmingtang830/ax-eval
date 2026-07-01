/**
 * Verify a generated pack's round-trip oracles against the live API.
 *
 * The executor (a clean subagent, per profile) performs the tasks and writes a
 * results file mapping task id -> { gid }. Verification is independent: we GET
 * the resource by id, strip the response envelope, and assert the field the
 * task set. Passing requires real API state, not the executor's self-report.
 */
import { readFileSync } from "node:fs";
import { BearerClient, resolveDotted, type ApiStyle } from "../http/client.js";
import { applyNs, NS_PLACEHOLDER, type TraceStep } from "../harness/executor.js";
import type { SurfaceId } from "../surface/types.js";
import { tasksForSurface } from "../surface/index.js";
import type { DiscoveryResult } from "./discovery.js";
import type { OracleResult, OracleSpec, TargetPack, Task } from "../schemas.js";
import { resolveSqlConn, runSqlCheck, type SqlConn } from "./sql-verify.js";
import { resolveEnvTemplate } from "../target/config.js";

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
  /** True when the pack marks this task N/A for the vendor (its only
   *  oracle is type "na") — per DAEB-1 methodology, N/A tasks are excluded
   *  from both the numerator and denominator of the pass rate, not
   *  counted as failures. */
  na: boolean;
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

async function verifyRoundtrip(
  task: Task,
  reported: ({ gid?: string } & Record<string, unknown>) | undefined,
  client: BearerClient,
  ns: string | undefined,
  fieldSelectParam: string | undefined,
  apiStyle: ApiStyle,
  sqlConn: SqlConn | null,
): Promise<OracleResult[]> {
  const out: OracleResult[] = [];
  // Resolve {ns} (per-run namespace) and ${ENV_VAR} (per-account identity,
  // e.g. Supabase's ${SUPABASE_PROJECT_REF}) in any path/query template.
  const applyNsTemplate = (template: string): string =>
    resolveEnvTemplate(ns ? template.split(NS_PLACEHOLDER).join(ns) : template);
  // Named placeholders beyond {ns}/{gid}: a check can reference a value only
  // the executor knows once it performs the task (e.g. {test_row_id} for an
  // RLS visibility check, or {duplicate_email} for a unique-constraint
  // check) — the executor reports it as an extra key alongside `gid`, the
  // same mechanism used for authField tokens. Left untouched if unreported
  // (so a genuinely missing value surfaces as a 404/not-found rather than a
  // silently broken literal "{name}" in the URL).
  const applyReportedFields = (template: string): string =>
    template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
      if (name === "ns" || name === "gid") return match;
      const value = reported?.[name];
      return typeof value === "string" ? value : match;
    });

  for (const oracle of task.oracles) {
    if (oracle.type !== "roundtrip") continue;

    // SQL wire-protocol targets (CockroachDB/PlanetScale): no {gid}
    // substitution — these checks address state by {ns}, not a
    // per-resource id, since a "row count" query has no single resource.
    if (oracle.sqlQuery) {
      if (!sqlConn) {
        out.push({ type: "roundtrip", passed: false, detail: "oracle has sqlQuery but pack declares no sql_conn" });
        continue;
      }
      if (!oracle.assertField) {
        out.push({ type: "roundtrip", passed: false, detail: "oracle missing assertField" });
        continue;
      }
      const query = applyReportedFields(applyNsTemplate(oracle.sqlQuery));
      const expectedValues = resolveExpectedValues(oracle, ns);
      try {
        const row = await runSqlCheck(sqlConn, query);
        const actual = resolveDotted(row, oracle.assertField);
        const passed = valuesMatch(actual, expectedValues, oracle.matchMode);
        out.push({
          type: "roundtrip",
          passed,
          detail: `${oracle.assertField}=${JSON.stringify(actual)} expected=${expectedDetail(expectedValues)}`,
        });
      } catch (err) {
        out.push({ type: "roundtrip", passed: false, detail: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }

    const gid = reported?.gid;
    // Only DAEB-1-style count/state checks that reference {gid} need one —
    // a "does this table have 100 rows" query addresses state by {ns}, not
    // a single resource. Templates that don't mention {gid} skip the check.
    const needsGid = (t: string | undefined) => Boolean(t?.includes("{gid}"));

    // GraphQL targets (Linear/Monday): substitute {gid} into the hand-authored
    // read-back query, POST it, and assert the dotted field against `data`.
    if (apiStyle === "graphql") {
      if (!oracle.readQueryTemplate || !oracle.assertField) {
        out.push({ type: "roundtrip", passed: false, detail: "oracle missing readQuery/assertField" });
        continue;
      }
      if (needsGid(oracle.readQueryTemplate) && !gid) {
        out.push({ type: "roundtrip", passed: false, detail: "no gid reported by executor" });
        continue;
      }
      const query = applyReportedFields(applyNsTemplate(oracle.readQueryTemplate)).split("{gid}").join(gid ?? "");
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

    // REST targets (Asana/Notion/Exa/DAEB-1 vendors): read back the path and assert the field.
    if (!oracle.readPathTemplate || !oracle.assertField) {
      out.push({ type: "roundtrip", passed: false, detail: "oracle missing readPath/assertField" });
      continue;
    }
    if (needsGid(oracle.readPathTemplate) && !gid) {
      out.push({ type: "roundtrip", passed: false, detail: "no gid reported by executor" });
      continue;
    }
    // Identity-scoped (e.g. RLS) check: authenticate as the token the
    // executor self-reported under this name, instead of the pack's
    // admin-level default (which typically bypasses row-level security).
    let requestClient = client;
    if (oracle.authField) {
      const token = reported?.[oracle.authField];
      if (typeof token !== "string" || !token) {
        out.push({ type: "roundtrip", passed: false, detail: `no "${oracle.authField}" reported by executor` });
        continue;
      }
      requestClient = client.withToken(token);
    }
    const path = applyReportedFields(applyNsTemplate(oracle.readPathTemplate)).replace("{gid}", gid ? encodeURIComponent(gid) : "");
    const expectedValues = resolveExpectedValues(oracle, ns);
    try {
      const method = oracle.readMethod ?? "GET";
      const body =
        method === "POST"
          ? await requestClient.post<Record<string, unknown>>(path, applyGidTemplate(oracle.readBodyTemplate, gid ?? ""))
          : await requestClient.get<Record<string, unknown>>(
              path,
              fieldSelectParam ? { [fieldSelectParam]: oracle.assertField } : undefined,
            );
      const actual = resolveDotted(body, oracle.assertField);
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
  }
  return out;
}

export async function verifyGeneratedPack(
  pack: TargetPack,
  executor: ExecutorResults,
  client: BearerClient,
  surface?: SurfaceId,
): Promise<RoundtripOutcome[]> {
  const outcomes: RoundtripOutcome[] = [];
  const tasks = surface ? tasksForSurface(pack, surface) : pack.tasks;
  const sqlConn = resolveSqlConn(pack);
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
        sqlConn,
      );
    } catch (err) {
      oracleResults = [];
      error = err instanceof Error ? err.message : String(err);
    }
    const na = task.oracles.length > 0 && task.oracles.every((o) => o.type === "na");
    const success = oracleResults.length > 0 && oracleResults.every((r) => r.passed);
    outcomes.push({
      taskId: task.id,
      difficulty: task.difficulty,
      profile: executor.profile,
      success,
      oracleResults,
      error,
      na,
    });
  }
  return outcomes;
}
