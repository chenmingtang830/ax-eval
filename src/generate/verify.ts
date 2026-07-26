/**
 * Verify a generated pack's round-trip oracles against the live API.
 *
 * The executor (a clean subagent, per profile) performs the tasks and writes a
 * results file mapping task id -> { gid }. Verification is independent: we GET
 * the resource by id, strip the response envelope, and assert the field the
 * task set. Passing requires real API state, not the executor's self-report.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { BearerClient, HttpApiError, resolveDotted, type ApiStyle } from "../http/client.js";
import { applyNs, NS_PLACEHOLDER, type TraceStep } from "../harness/executor.js";
import type { ObservedRun } from "../harness/transcript.js";
import type { SurfaceId } from "../surface/types.js";
import { tasksForSurface } from "../surface/index.js";
import type { DiscoveryResult } from "./discovery.js";
import {
  providerForOracle,
  runProviderOracle,
  type OracleProviderRegistry,
  type VersionedOracleProvider,
} from "./oracle-provider.js";
import type { OracleResult, OracleSpec, TargetPack, Task } from "../schemas.js";
import { resolveSqlConn, runSqlCheck, type SqlConn } from "./sql-verify.js";
import { resolveMongoConn, runMongoCheck, type MongoConn, type MongoQuery } from "./mongo-verify.js";
import { resolveEnvTemplate, type EnvSource } from "../target/config.js";
import { parseJsonWithRecovery } from "../util/json-parse.js";
import { gradeSurfaceHonesty } from "./surface-honesty.js";

export { parseJsonWithRecovery } from "../util/json-parse.js";

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
   *  oracle is type "na") — per DAEB methodology, N/A tasks are excluded
   *  from both the numerator and denominator of the pass rate, not
   *  counted as failures. */
  na: boolean;
}

export interface VerifyGeneratedPackOptions {
  /** Objective harness transcript used for surface-honesty grading. */
  observedRun?: ObservedRun;
  /** Validated execution trace supplied independently of the transcript. */
  trace?: readonly TraceStep[];
  /** Explicit providers for this call. When supplied, global providers are ignored. */
  oracleProviders?: OracleProviderRegistry;
  /** Explicit environment source for URL templates and built-in compatibility
   * providers. Legacy callers default to process.env. */
  env?: EnvSource;
  /** Explicit verifier-only credentials exposed to extension providers. This
   * never defaults to process.env. */
  credentials?: Readonly<Record<string, string | undefined>>;
}

function readRegularFileNoFollow(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`artifact is not a regular file: ${path}`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function loadResults(path: string): ExecutorResults {
  return parseJsonWithRecovery<ExecutorResults>(readRegularFileNoFollow(path));
}

/** Load a sibling *.trace.json if present (observability); empty if missing. */
export function loadTrace(path: string): TraceStep[] {
  try {
    const parsed = parseJsonWithRecovery(readRegularFileNoFollow(path));
    return Array.isArray(parsed) ? (parsed as TraceStep[]) : [];
  } catch {
    return [];
  }
}

export function loadRequiredTrace(path: string): TraceStep[] {
  const parsed = JSON.parse(readRegularFileNoFollow(path)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("required trace artifact must be a JSON array");
  return parsed as TraceStep[];
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

function resolveProbeExpectedValues(oracle: OracleSpec, ns: string | undefined): unknown[] {
  return [oracle.probeExpected, ...(oracle.probeExpectedAny ?? [])]
    .filter((value) => value !== undefined)
    .map((value) => resolveExpected(value, ns));
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

function isAbsoluteHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function valuesMatch(actual: unknown, expectedValues: unknown[], mode: OracleSpec["matchMode"]): boolean {
  if (mode === "url") {
    const normalizedActual = normalizeUrl(actual);
    return expectedValues.some((expected) => normalizedActual !== null && normalizedActual === normalizeUrl(expected));
  }
  return expectedValues.some((expected) => {
    if (actual === expected) return true;
    // node-postgres returns BIGINT/NUMERIC columns (e.g. COUNT(*)) as strings
    // to avoid JS precision loss — a check comparing that column against a
    // literal number (the natural, readable way to author `expected: 5`)
    // would otherwise always fail on a strict type mismatch alone.
    if (typeof actual === "string" && typeof expected === "number" && actual.trim() !== "" && Number(actual) === expected) return true;
    if (typeof expected === "string" && typeof actual === "number" && expected.trim() !== "" && Number(expected) === actual) return true;
    return false;
  });
}

function expectedDetail(expectedValues: unknown[]): string {
  return expectedValues.length === 1
    ? JSON.stringify(expectedValues[0])
    : `[${expectedValues.map((v) => JSON.stringify(v)).join(" | ")}]`;
}

function httpErrorOutcome(oracle: OracleSpec, error: HttpApiError, ns: string | undefined): OracleResult {
  const statusPassed = !oracle.expectedHttpStatuses?.length
    || oracle.expectedHttpStatuses.includes(error.status);
  const expectedValues = resolveExpectedValues(oracle, ns);
  const actual = oracle.assertField ? resolveDotted(error.body, oracle.assertField) : undefined;
  const bodyPassed = oracle.expected === undefined
    || (Boolean(oracle.assertField) && valuesMatch(actual, expectedValues, oracle.matchMode));
  return {
    type: "roundtrip",
    passed: statusPassed && bodyPassed,
    detail: [
      `HTTP ${error.status} expected=${oracle.expectedHttpStatuses?.join("/") ?? "any error"}`,
      oracle.expected === undefined
        ? undefined
        : `${oracle.assertField ?? "(missing field)"}=${JSON.stringify(actual)} expected=${expectedDetail(expectedValues)}`,
    ].filter(Boolean).join("; "),
  };
}

function errorMessageFromResult(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { code?: unknown; message?: unknown; errno?: unknown; sqlState?: unknown };
  if (typeof record.message !== "string" || !record.message.trim()) return undefined;
  const prefix = [record.code, record.errno, record.sqlState]
    .filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    .join("/");
  return prefix ? `${prefix}: ${record.message}` : record.message;
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

function applyStringTemplates(
  value: string,
  ns: string | undefined,
  gid: string | undefined,
  reported: ({ gid?: string } & Record<string, unknown>) | undefined,
  encodeGid = true,
  env: EnvSource = process.env,
): string {
  const withNs = resolveEnvTemplate(ns ? value.split(NS_PLACEHOLDER).join(ns) : value, env);
  return withNs.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
    if (name === "ns") return ns ?? match;
    if (name === "gid") return gid ? (encodeGid ? encodeURIComponent(gid) : gid) : match;
    const reportedValue = reported?.[name];
    return typeof reportedValue === "string" ? reportedValue : match;
  });
}

function applyOracleTemplate(
  value: unknown,
  ns: string | undefined,
  gid: string | undefined,
  reported: ({ gid?: string } & Record<string, unknown>) | undefined,
  env: EnvSource = process.env,
): unknown {
  if (typeof value === "string") return applyStringTemplates(value, ns, gid, reported, false, env);
  if (Array.isArray(value)) return value.map((entry) => applyOracleTemplate(entry, ns, gid, reported, env));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = applyOracleTemplate(entry, ns, gid, reported, env);
    }
    return out;
  }
  return value;
}

async function verifyRoundtrip(
  pack: TargetPack,
  task: Task,
  reported: ({ gid?: string } & Record<string, unknown>) | undefined,
  client: BearerClient,
  ns: string | undefined,
  sqlConn: SqlConn | null,
  mongoConn: MongoConn | null,
  trace: TraceStep[],
  selectProvider: (oracle: OracleSpec) => VersionedOracleProvider | null | undefined,
  env: EnvSource,
  credentials: Readonly<Record<string, string | undefined>>,
): Promise<OracleResult[]> {
  const fieldSelectParam = pack.field_select_param;
  const apiStyle: ApiStyle = pack.api_style;
  const out: OracleResult[] = [];
  // Resolve {ns} (per-run namespace) and ${ENV_VAR} (per-account identity,
  // e.g. Supabase's ${SUPABASE_PROJECT_REF}) in any path/query template.
  const applyNsTemplate = (template: string): string =>
    applyStringTemplates(template, ns, undefined, undefined, true, env);
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
    // Registered providers (e.g. SQL/Mongo read-back for database packs) own
    // their oracles outright; the built-in HTTP round-trip is the default.
    const provider = selectProvider(oracle);
    if (provider === null) {
      out.push({ type: oracle.type, passed: false, detail: "oracle provider selection failed" });
      continue;
    }
    if (provider) {
      out.push(await runProviderOracle(provider, oracle, {
        pack,
        task,
        reported,
        ns,
        trace,
        credentials,
      }));
      continue;
    }
    if (oracle.type !== "roundtrip") continue;

    if (oracle.mongoQuery) {
      if (!mongoConn) {
        out.push({ type: "roundtrip", passed: false, detail: "oracle has mongoQuery but pack declares no mongo_conn" });
        continue;
      }
      if (!oracle.assertField) {
        out.push({ type: "roundtrip", passed: false, detail: "oracle missing assertField" });
        continue;
      }
      const query = applyOracleTemplate(oracle.mongoQuery, ns, reported?.gid, reported, env) as MongoQuery;
      const expectedValues = resolveExpectedValues(oracle, ns);
      try {
        const result = await runMongoCheck(mongoConn, query);
        const actual = resolveDotted(result, oracle.assertField);
        const passed = valuesMatch(actual, expectedValues, oracle.matchMode);
        out.push({
          type: "roundtrip",
          passed,
          detail: [
            `${oracle.assertField}=${JSON.stringify(actual)} expected=${expectedDetail(expectedValues)}`,
            actual === undefined ? errorMessageFromResult(result) : undefined,
          ].filter(Boolean).join("; "),
        });
      } catch (err) {
        out.push({ type: "roundtrip", passed: false, detail: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }

    // SQL wire-protocol targets (CockroachDB/PlanetScale): no {gid}
    // substitution — these checks address state by {ns}, not a
    // per-resource id, since a "row count" query has no single resource.
    if (oracle.sqlQuery) {
      // sqlConnField: the resource under test lives behind a DIFFERENT
      // credential than the pack's default (e.g. a new branch created
      // during a restore, or a scoped role created for RBAC testing) —
      // the executor already had this connection string in hand to do
      // the work, so this just asks it to also report it.
      let effectiveSqlConn = sqlConn;
      let rolePrefix = "";
      const safeNs = (ns ?? "").replace(/[^a-zA-Z0-9_]/g, "_");
      const role = oracle.sqlRoleTemplate
        ? oracle.sqlRoleTemplate.replace(/\{ns\}/g, safeNs)
        : oracle.sqlRoleField ? reported?.[oracle.sqlRoleField] : undefined;
      if (oracle.sqlRoleTemplate || oracle.sqlRoleField) {
        if (typeof role !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/i.test(role)) {
          const source = oracle.sqlRoleTemplate ? `"${oracle.sqlRoleTemplate}"` : `"${oracle.sqlRoleField}"`;
          out.push({ type: "roundtrip", passed: false, detail: `no valid SQL role resolved from ${source}` });
          continue;
        }
        rolePrefix = `SET ROLE "${role}"; `;
      } else if (oracle.sqlConnField) {
        const reportedConn = reported?.[oracle.sqlConnField];
        if (typeof reportedConn !== "string" || !reportedConn) {
          out.push({ type: "roundtrip", passed: false, detail: `no "${oracle.sqlConnField}" reported by executor` });
          continue;
        }
        effectiveSqlConn = { dialect: oracle.sqlDialect ?? sqlConn?.dialect ?? "postgres", connectionString: reportedConn };
      }
      if (!effectiveSqlConn) {
        out.push({ type: "roundtrip", passed: false, detail: "oracle has sqlQuery but pack declares no sql_conn" });
        continue;
      }
      if (!oracle.assertField) {
        out.push({ type: "roundtrip", passed: false, detail: "oracle missing assertField" });
        continue;
      }
      const query = rolePrefix + applyReportedFields(applyNsTemplate(oracle.sqlQuery));
      const expectedValues = resolveExpectedValues(oracle, ns);
      try {
        if (oracle.probeSqlQuery) {
          const probeQuery = applyReportedFields(applyNsTemplate(oracle.probeSqlQuery));
          const probeResult = await runSqlCheck(effectiveSqlConn, probeQuery);
          const probeField = oracle.probeAssertField ?? "code";
          const probeActual = resolveDotted(probeResult, probeField);
          const probeExpected = resolveProbeExpectedValues(oracle, ns);
          const isErrorObject = !Array.isArray(probeResult) && Boolean(errorMessageFromResult(probeResult));
          const probePassed = oracle.probeExpectError
            ? isErrorObject && (!probeExpected.length || valuesMatch(probeActual, probeExpected, oracle.matchMode))
            : valuesMatch(probeActual, probeExpected, oracle.matchMode);
          out.push({
            type: "verifier-probe",
            passed: probePassed,
            detail: `${probeField}=${JSON.stringify(probeActual)} expected=${expectedDetail(probeExpected)}${oracle.probeExpectError ? ` error=${isErrorObject}` : ""}`,
          });
          if (!probePassed) continue;
        }
        const row = await runSqlCheck(effectiveSqlConn, query);
        const isErrorObject = !Array.isArray(row) && Boolean(errorMessageFromResult(row));
        const field = oracle.assertOutcome === "error" ? (oracle.assertField ?? "code") : oracle.assertField;
        const actual = resolveDotted(row, field);
        const passed = oracle.assertOutcome === "error"
          ? isErrorObject && valuesMatch(actual, expectedValues, oracle.matchMode)
          : valuesMatch(actual, expectedValues, oracle.matchMode);
        out.push({
          type: "roundtrip",
          passed,
          detail: [
            `${field}=${JSON.stringify(actual)} expected=${expectedDetail(expectedValues)}${oracle.assertOutcome === "error" ? ` error=${isErrorObject}` : ""}`,
            actual === undefined ? errorMessageFromResult(row) : undefined,
          ].filter(Boolean).join("; "),
        });
      } catch (err) {
        out.push({ type: "roundtrip", passed: false, detail: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }

    const gid = reported?.gid;
    // Only DAEB-style count/state checks that reference {gid} need one —
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
        out.push(oracle.assertOutcome === "error" && err instanceof HttpApiError
          ? httpErrorOutcome(oracle, err, ns)
          : {
              type: "roundtrip",
              passed: false,
              detail: err instanceof Error ? err.message : String(err),
            });
      }
      continue;
    }

    // REST targets (Asana/Notion/Exa/DAEB vendors): read back the path and assert the field.
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
    const taskBaseUrl = typeof reported?.__task_base_url === "string"
      ? reported.__task_base_url.trim()
      : "";
    if (isAbsoluteHttpUrl(taskBaseUrl)) {
      requestClient = requestClient.withBaseUrl(taskBaseUrl);
    }
    const path = applyReportedFields(applyNsTemplate(oracle.readPathTemplate)).replace("{gid}", gid ? encodeURIComponent(gid) : "");
    const expectedValues = resolveExpectedValues(oracle, ns);
    try {
      const method = oracle.readMethod ?? "GET";
      const body =
        method === "POST"
          ? await requestClient.post<Record<string, unknown>>(
              path,
              applyGidTemplate(applyOracleTemplate(oracle.readBodyTemplate, ns, gid, reported), gid ?? ""),
            )
          : await requestClient.get<Record<string, unknown>>(
              path,
              fieldSelectParam ? { [fieldSelectParam]: oracle.assertField } : undefined,
            );
      const actual = resolveDotted(body, oracle.assertField);
      const passed = oracle.assertOutcome === "error"
        ? false
        : valuesMatch(actual, expectedValues, oracle.matchMode);
      out.push({
        type: "roundtrip",
        passed,
        detail: `${oracle.assertField}=${JSON.stringify(actual)} expected=${expectedDetail(expectedValues)}`,
      });
    } catch (err) {
      if (oracle.assertOutcome === "error" && err instanceof HttpApiError) {
        out.push(httpErrorOutcome(oracle, err, ns));
        continue;
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
  observedRun?: ObservedRun | TraceStep[],
  options: VerifyGeneratedPackOptions = {},
): Promise<RoundtripOutcome[]> {
  const outcomes: RoundtripOutcome[] = [];
  const tasks = surface ? tasksForSurface(pack, surface) : pack.tasks;
  const env = options.env ?? process.env;
  const providerSelections = new Map<OracleSpec, VersionedOracleProvider | null | undefined>();
  const selectProvider = (oracle: OracleSpec): VersionedOracleProvider | null | undefined => {
    if (providerSelections.has(oracle)) return providerSelections.get(oracle);
    let provider: VersionedOracleProvider | null | undefined;
    try {
      provider = options.oracleProviders === undefined
        ? providerForOracle(oracle)
        : options.oracleProviders.providerFor(oracle);
    } catch {
      provider = null;
    }
    providerSelections.set(oracle, provider);
    return provider;
  };
  const usesBuiltIn = (oracle: OracleSpec): boolean => selectProvider(oracle) === undefined;
  const sqlConn = tasks.some((task) => task.oracles.some((oracle) => oracle.sqlQuery && usesBuiltIn(oracle)))
    ? resolveSqlConn(pack, env)
    : null;
  const mongoConn = tasks.some((task) => task.oracles.some((oracle) => oracle.mongoQuery && usesBuiltIn(oracle)))
    ? resolveMongoConn(pack, env)
    : null;
  const trace = options.trace ? [...options.trace] : Array.isArray(observedRun) ? observedRun : [];
  const objectiveRun = options.observedRun ?? (observedRun && !Array.isArray(observedRun) ? observedRun : undefined);
  const honestySurface: SurfaceId =
    surface ?? (executor.surface === "cli" || executor.surface === "sdk" || executor.surface === "mcp" || executor.surface === "api"
      ? executor.surface
      : "api");
  const honesty = objectiveRun
    ? gradeSurfaceHonesty(objectiveRun, honestySurface, pack, env)
    : null;
  for (const task of tasks) {
    const reported = executor.results[task.id];
    let oracleResults: OracleResult[];
    let error: string | null = null;
    try {
      oracleResults = await verifyRoundtrip(
        pack,
        task,
        reported,
        client,
        executor.ns,
        sqlConn,
        mongoConn,
        trace,
        selectProvider,
        env,
        options.credentials ?? {},
      );
    } catch (err) {
      oracleResults = [];
      error = err instanceof Error ? err.message : String(err);
    }
    if (honesty && !honesty.passed) {
      oracleResults.push({
        type: "surface-honesty",
        passed: false,
        detail: honesty.detail,
      });
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
