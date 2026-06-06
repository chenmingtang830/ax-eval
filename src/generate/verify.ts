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
import type { OracleResult, TargetPack, Task } from "../schemas.js";

export interface ExecutorResults {
  profile: string;
  /** The per-execution namespace this run used; substituted into {ns} oracles. */
  ns?: string;
  /** Which surface the agent operated the product through (api/cli/sdk/mcp).
   *  Self-described by the executor; the CLI's --surface flag overrides it. */
  surface?: string;
  /** Phase-0 discovery funnel this profile self-reported (behavioral AEO). */
  discovery?: DiscoveryResult;
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
      const expected = resolveExpected(oracle.expected, ns);
      try {
        const data = await client.graphql<Record<string, unknown>>(query);
        const actual = resolveDotted(data, oracle.assertField);
        const passed = actual === expected;
        out.push({
          type: "roundtrip",
          passed,
          detail: `${oracle.assertField}=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
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

    // REST targets (Asana/Notion): GET the read-back path and assert the field.
    if (!oracle.readPathTemplate || !oracle.assertField) {
      out.push({ type: "roundtrip", passed: false, detail: "oracle missing readPath/assertField" });
      continue;
    }
    const path = oracle.readPathTemplate.replace("{gid}", encodeURIComponent(gid));
    const expected = resolveExpected(oracle.expected, ns);
    try {
      const query = fieldSelectParam ? { [fieldSelectParam]: oracle.assertField } : undefined;
      const body = await client.get<Record<string, unknown>>(path, query);
      const actual = resolveDotted(body, oracle.assertField);
      const passed = actual === expected;
      out.push({
        type: "roundtrip",
        passed,
        detail: `${oracle.assertField}=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
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
