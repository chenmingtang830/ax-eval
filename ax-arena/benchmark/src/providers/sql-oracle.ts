import type {
  OracleResult,
  OracleSpec,
  OracleVerifyContext,
  VersionedOracleProvider,
} from "ax-eval";
import {
  applyStringTemplates,
  errorMessageFromResult,
  expectedDetail,
  expectedValues,
  probeExpectedValues,
  resolveDotted,
  valuesMatch,
} from "./oracle-utils.js";

export interface SqlConnection {
  dialect: "postgres" | "mysql";
  connectionString: string;
}

export type SqlQueryRunner = (
  connection: SqlConnection,
  query: string,
  role?: string,
) => Promise<unknown>;

function sqlError(error: unknown): Record<string, unknown> {
  const value = error as { code?: string; message?: string; errno?: number; sqlState?: string };
  return {
    code: value.code,
    message: value.message,
    errno: value.errno,
    sqlState: value.sqlState,
  };
}

/** Execute a verifier query through a fresh connection. Arena owns these
 * database drivers; core only sees the OracleProvider result. */
export async function runSqlQuery(
  connection: SqlConnection,
  query: string,
  role?: string,
): Promise<unknown> {
  if (connection.dialect === "postgres") {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: connection.connectionString });
    client.on?.("error", () => {});
    await client.connect();
    try {
      try {
        await client.query("RESET ROLE");
        if (role) {
          if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(role)) throw new Error("invalid PostgreSQL verifier role");
          await client.query(`SET ROLE "${role.replaceAll('"', '""')}"`);
        }
      } catch {
        throw new Error("PostgreSQL verifier role setup failed");
      }
      try {
        const result = await client.query(query);
        return result.rows;
      } catch (error) {
        return sqlError(error);
      }
    } finally {
      await client.end();
    }
  }

  if (role) throw new Error("SQL verifier roles are supported only for PostgreSQL");
  const mysql = await import("mysql2/promise");
  const client = await mysql.createConnection(connection.connectionString);
  try {
    const [rows] = await client.execute(query);
    return rows;
  } catch (error) {
    return sqlError(error);
  } finally {
    await client.end();
  }
}

function packConnection(ctx: OracleVerifyContext): SqlConnection | undefined {
  if (!ctx.pack.sql_conn) return undefined;
  const envName = ctx.pack.sql_conn.connection_string_env;
  const connectionString = ctx.credentials[envName];
  if (!connectionString) {
    throw new Error(`sql_conn declared (credential ${envName}) but that credential is unset`);
  }
  return { dialect: ctx.pack.sql_conn.dialect, connectionString };
}

function failed(detail: string, type = "roundtrip"): OracleResult {
  return { type, passed: false, detail };
}

async function verifySql(
  oracle: OracleSpec,
  ctx: OracleVerifyContext,
  run: SqlQueryRunner,
): Promise<readonly OracleResult[]> {
  let connection: SqlConnection | undefined;
  let verifierRole: string | undefined;
  const safeNs = (ctx.ns ?? "").replace(/[^a-zA-Z0-9_]/g, "_");
  const role = oracle.sqlRoleTemplate
    ? oracle.sqlRoleTemplate.replace(/\{ns\}/g, safeNs)
    : oracle.sqlRoleField ? ctx.reported?.[oracle.sqlRoleField] : undefined;

  if (oracle.sqlRoleTemplate || oracle.sqlRoleField) {
    connection = packConnection(ctx);
    if (typeof role !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/i.test(role)) {
      const source = oracle.sqlRoleTemplate ? `"${oracle.sqlRoleTemplate}"` : `"${oracle.sqlRoleField}"`;
      return [failed(`no valid SQL role resolved from ${source}`)];
    }
    verifierRole = role;
  } else if (oracle.sqlConnField) {
    const reportedConnection = ctx.reported?.[oracle.sqlConnField];
    if (typeof reportedConnection !== "string" || !reportedConnection) {
      return [failed(`no "${oracle.sqlConnField}" reported by executor`)];
    }
    connection = {
      dialect: oracle.sqlDialect ?? ctx.pack.sql_conn?.dialect ?? "postgres",
      connectionString: reportedConnection,
    };
  } else {
    connection = packConnection(ctx);
  }

  if (!connection) return [failed("oracle has sqlQuery but pack declares no sql_conn")];
  if (!oracle.assertField) return [failed("oracle missing assertField")];

  const expected = expectedValues(oracle, ctx.ns);
  const outcomes: OracleResult[] = [];

  if (oracle.probeSqlQuery) {
    const result = await run(connection, applyStringTemplates(oracle.probeSqlQuery, ctx, false));
    const field = oracle.probeAssertField ?? "code";
    const actual = resolveDotted(result, field);
    const probeExpected = probeExpectedValues(oracle, ctx.ns);
    const isError = !Array.isArray(result) && Boolean(errorMessageFromResult(result));
    const passed = oracle.probeExpectError
      ? isError && (!probeExpected.length || valuesMatch(actual, probeExpected, oracle.matchMode))
      : valuesMatch(actual, probeExpected, oracle.matchMode);
    outcomes.push({
      type: "verifier-probe",
      passed,
      detail: `${field}=${JSON.stringify(actual)} expected=${expectedDetail(probeExpected)}${oracle.probeExpectError ? ` error=${isError}` : ""}`,
    });
    if (!passed) return outcomes;
  }

  const result = await run(connection, applyStringTemplates(oracle.sqlQuery!, ctx, false), verifierRole);
  const isError = !Array.isArray(result) && Boolean(errorMessageFromResult(result));
  const field = oracle.assertOutcome === "error" ? (oracle.assertField ?? "code") : oracle.assertField;
  const actual = resolveDotted(result, field);
  const passed = oracle.assertOutcome === "error"
    ? isError && valuesMatch(actual, expected, oracle.matchMode)
    : valuesMatch(actual, expected, oracle.matchMode);
  outcomes.push({
    type: "roundtrip",
    passed,
    detail: [
      `${field}=${JSON.stringify(actual)} expected=${expectedDetail(expected)}${oracle.assertOutcome === "error" ? ` error=${isError}` : ""}`,
      actual === undefined ? errorMessageFromResult(result) : undefined,
    ].filter(Boolean).join("; "),
  });
  return outcomes;
}

export function createSqlOracleProvider(run: SqlQueryRunner = runSqlQuery): VersionedOracleProvider {
  return {
    id: "arena-sql",
    version: "1.0.0",
    matches: (oracle) => typeof oracle.sqlQuery === "string" && oracle.sqlQuery.length > 0,
    verify: (oracle, ctx) => verifySql(oracle, ctx, run),
  };
}
