import type { TargetPack } from "../schemas.js";
import {
  DatabaseCheckError,
  safeDatabaseError,
  type DatabaseCheckPhase,
} from "./database-error.js";

export interface SqlConnection {
  dialect: "postgres" | "mysql";
  connectionString: string;
}

export interface SqlCheckOptions {
  role?: string;
}

const MUTATING_SQL = /\b(?:insert|update|delete|merge|upsert|create|alter|drop|truncate|grant|revoke|copy|call|do|execute|replace|lock|unlock|into)\b/i;
const SIDE_EFFECTING_SQL_FUNCTION = /\b(?:nextval|setval|set_config|dblink_exec|lo_import|lo_unlink|pg_advisory_lock|pg_terminate_backend|pg_cancel_backend)\s*\(/i;
const SESSION_STATE_SQL = /\b(?:set\s+(?:(?:local|session)\s+)?(?:role|session\s+authorization)|reset\s+(?:role|session\s+authorization|all))\b/i;

function sqlForInspection(query: string): string {
  return query
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .trim();
}

export function assertReadOnlySql(query: string): void {
  const inspected = sqlForInspection(query).replace(/;\s*$/, "").trim();
  if (!inspected) throw new Error("SQL verifier query is empty");
  if (inspected.includes(";")) throw new Error("SQL verifier queries must contain exactly one statement");
  if (SESSION_STATE_SQL.test(inspected)) {
    throw new Error("SQL verifier query changes session authorization or role state");
  }
  if (!/^(?:select|with|show|explain|describe)\b/i.test(inspected)) {
    throw new Error("SQL verifier queries must be read-only SELECT/CTE/SHOW/EXPLAIN statements");
  }
  if (/\bfor\s+(?:update|share)\b/i.test(inspected)) {
    throw new Error("SQL verifier query requests a row lock");
  }
  if (MUTATING_SQL.test(inspected)) {
    throw new Error("SQL verifier query contains a mutating statement");
  }
  if (SIDE_EFFECTING_SQL_FUNCTION.test(inspected)) {
    throw new Error("SQL verifier query calls a side-effecting function");
  }
}

function safeTemplateValue(name: string, value: string | undefined): string {
  if (!value) throw new Error(`SQL verifier query requires {${name}}`);
  if (!/^[A-Za-z0-9_:-]+$/.test(value)) {
    throw new Error(`SQL verifier template value {${name}} contains unsafe characters`);
  }
  return value;
}

export function renderSqlQuery(
  template: string,
  values: { ns?: string; gid?: string },
): string {
  const rendered = template.replace(/\{(ns|gid)\}/g, (_, name: "ns" | "gid") =>
    safeTemplateValue(name, values[name]));
  const unsupported = rendered.match(/\{([^}]+)\}/)?.[1];
  if (unsupported) throw new Error(`unsupported SQL verifier template {${unsupported}}`);
  assertReadOnlySql(rendered);
  return rendered;
}

export function renderSqlRole(
  template: string,
  values: { ns?: string; gid?: string },
): string {
  const rendered = template.replace(/\{(ns|gid)\}/g, (_, name: "ns" | "gid") =>
    safeTemplateValue(name, values[name]));
  const unsupported = rendered.match(/\{([^}]+)\}/)?.[1];
  if (unsupported) throw new Error(`unsupported SQL role template {${unsupported}}`);
  return assertSqlRole(rendered);
}

function assertSqlRole(role: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(role)) {
    throw new Error("SQL verifier role must be a simple identifier");
  }
  return role;
}

export function resolveSqlConnection(pack: TargetPack): SqlConnection | null {
  if (!pack.sql_conn) return null;
  const connectionString = process.env[pack.sql_conn.connection_string_env]?.trim();
  if (!connectionString) {
    throw new Error(
      `sql_conn declared (env ${pack.sql_conn.connection_string_env}) but that env var is unset`,
    );
  }
  return { dialect: pack.sql_conn.dialect, connectionString };
}

async function runDatabaseOperation<T>(
  connectionString: string,
  phase: DatabaseCheckPhase,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw error instanceof DatabaseCheckError
      ? error
      : safeDatabaseError(error, connectionString, phase);
  }
}

export async function runSqlCheck(
  connection: SqlConnection,
  query: string,
  options: SqlCheckOptions = {},
): Promise<unknown> {
  try {
    assertReadOnlySql(query);
    const role = options.role ? assertSqlRole(options.role) : undefined;
    if (role && connection.dialect !== "postgres") {
      throw new Error("SQL role verification requires postgres");
    }
    if (connection.dialect === "postgres") {
      const { Client } = await runDatabaseOperation(connection.connectionString, "connect", () => import("pg"));
      const client = new Client({
        connectionString: connection.connectionString,
        connectionTimeoutMillis: 10_000,
        query_timeout: 15_000,
      });
      await runDatabaseOperation(connection.connectionString, "connect", () => client.connect());
      try {
        await runDatabaseOperation(connection.connectionString, "transaction", () => client.query("BEGIN READ ONLY"));
        if (role) {
          await runDatabaseOperation(connection.connectionString, "role", () => client.query(`SET LOCAL ROLE "${role}"`));
        }
        const result = await runDatabaseOperation(connection.connectionString, "query", () => client.query(query));
        return result.rows[0] ?? {};
      } finally {
        try {
          await runDatabaseOperation(connection.connectionString, "cleanup", () => client.query("ROLLBACK"));
        } finally {
          await runDatabaseOperation(connection.connectionString, "cleanup", () => client.end());
        }
      }
    }

    const mysql = await runDatabaseOperation(connection.connectionString, "connect", () => import("mysql2/promise"));
    const client = await runDatabaseOperation(connection.connectionString, "connect", () => mysql.createConnection({
      uri: connection.connectionString,
      connectTimeout: 10_000,
      multipleStatements: false,
    }));
    try {
      await runDatabaseOperation(connection.connectionString, "transaction", () => client.query("START TRANSACTION READ ONLY"));
      const [rows] = await runDatabaseOperation(connection.connectionString, "query", () => client.query(query));
      return Array.isArray(rows) ? rows[0] ?? {} : rows;
    } finally {
      try {
        await runDatabaseOperation(connection.connectionString, "cleanup", () => client.rollback());
      } finally {
        await runDatabaseOperation(connection.connectionString, "cleanup", () => client.end());
      }
    }
  } catch (error) {
    throw error instanceof DatabaseCheckError
      ? error
      : safeDatabaseError(error, connection.connectionString, "validate");
  }
}
