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

async function verifyRoundtrip(
  task: Task,
  reported: { gid?: string } | undefined,
  client: BearerClient,
  ns: string | undefined,
  fieldSelectParam: string | undefined,
  apiStyle: ApiStyle,
): Promise<OracleResult[]> {
  const out: OracleResult[] = [];
  for (const oracle of task.oracles) {
    if (oracle.type !== "roundtrip") continue;
    const gid = reported?.gid;
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
    const path = oracle.readPathTemplate.replace("{gid}", encodeURIComponent(gid));
    const expectedValues = resolveExpectedValues(oracle, ns);
    try {
      const method = oracle.readMethod ?? "GET";
      const body =
        method === "POST"
          ? await client.post<Record<string, unknown>>(path, applyGidTemplate(oracle.readBodyTemplate, gid))
          : await client.get<Record<string, unknown>>(
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
): Promise<RoundtripOutcome[]> {
  const outcomes: RoundtripOutcome[] = [];
  for (const task of pack.tasks) {
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
