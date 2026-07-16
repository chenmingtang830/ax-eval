/**
 * SQL wire-protocol round-trip check: for vendors whose data plane has no
 * REST query endpoint (e.g. CockroachDB, PlanetScale run raw Postgres/MySQL
 * wire protocol), the oracle can't be a REST readPathTemplate — it has to
 * open a real DB connection and run SQL. Isolated in its own module so the
 * `pg`/`mysql2` drivers only load when a pack actually declares `sql_conn`.
 */
import type { TargetPack } from "../schemas.js";

export interface SqlConn {
  dialect: "postgres" | "mysql";
  connectionString: string;
}

/** Resolve a pack's `sql_conn` block into a connection string read from env.
 *  Returns null if the pack declares no SQL connection. */
export function resolveSqlConn(pack: TargetPack): SqlConn | null {
  if (!pack.sql_conn) return null;
  const connectionString = process.env[pack.sql_conn.connection_string_env];
  if (!connectionString) {
    throw new Error(
      `sql_conn declared (env ${pack.sql_conn.connection_string_env}) but that env var is unset`,
    );
  }
  return { dialect: pack.sql_conn.dialect, connectionString };
}

/** Run one SQL query and return a value suitable for resolveDotted().
 *
 * On success: the FULL rows array (e.g. `[{ count: "100" }]`) — this
 * mirrors PostgREST's raw array response shape, so an oracle-extract check
 * written as `assert_field: "0.count"` (array-index-then-field, the same
 * convention used for REST checks) resolves the same way regardless of
 * whether the vendor speaks REST or raw SQL.
 * On a driver error (e.g. a deliberate duplicate-key INSERT to confirm a
 * unique constraint): a flat object with the driver's own error fields
 * (`code`, `message`, `sqlState`/`errno`), NOT a thrown exception — this
 * mirrors how a REST oracle reads an error code out of a normal JSON error
 * body (`assert_field: "code"`, no array index).
 *
 * Opens and closes a fresh connection per call — verification-time
 * correctness, not execution throughput. */
export async function runSqlCheck(conn: SqlConn, query: string): Promise<unknown> {
  if (conn.dialect === "postgres") {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: conn.connectionString });
    // A peer reset can be emitted by pg after query() rejects. Registering an
    // error listener keeps verification failures structured instead of letting
    // Node terminate on an unhandled EventEmitter error.
    client.on?.("error", () => {});
    await client.connect();
    try {
      // Session hygiene: never inherit a prior SET ROLE from a pooled/mis-shared
      // identity. Deny probes that need SET ROLE include it in the same query.
      const res = await client.query(`RESET ROLE; ${query}`);
      return res.rows;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { code: e.code, message: e.message };
    } finally {
      await client.end();
    }
  }
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection(conn.connectionString);
  try {
    const [rows] = await connection.execute(query);
    return rows;
  } catch (err) {
    const e = err as { code?: string; message?: string; errno?: number; sqlState?: string };
    return { code: e.code, message: e.message, errno: e.errno, sqlState: e.sqlState };
  } finally {
    await connection.end();
  }
}
