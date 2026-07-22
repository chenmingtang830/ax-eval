import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TargetPackSchema,
  createOracleProviderRegistry,
  verifyGeneratedPack,
  type ExecutorResults,
  type TargetPack,
} from "ax-eval";
import {
  createMongoOracleProvider,
  createSqlOracleProvider,
  runSqlQuery,
  type MongoConnection,
  type MongoQuery,
  type SqlConnection,
} from "../src/providers/index.js";

const postgresDriver = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("pg", () => ({
  Client: class {
    on(): void {}
    async connect(): Promise<void> {}
    async query(...args: unknown[]): Promise<unknown> {
      return postgresDriver.query(...args);
    }
    async end(): Promise<void> {}
  },
}));

beforeEach(() => {
  postgresDriver.query.mockReset();
});

function packWith(override: Record<string, unknown>): TargetPack {
  return TargetPackSchema.parse({
    name: "database-provider-test",
    base_url: "https://api.example.test",
    tasks: [],
    ...override,
  });
}

function executor(
  taskId: string,
  reported: Record<string, unknown> = {},
  ns = "trial-1",
): ExecutorResults {
  return {
    profile: "test",
    surface: "cli",
    ns,
    results: { [taskId]: reported },
  };
}

describe("arena SQL oracle provider", () => {
  it("runs an expected-error probe before a numeric-compatible read-back", async () => {
    const calls: Array<{ connection: SqlConnection; query: string }> = [];
    const provider = createSqlOracleProvider(async (connection, query) => {
      calls.push({ connection, query });
      return query.includes("duplicate_probe")
        ? { code: "23505", message: "duplicate key" }
        : [{ count: "1" }];
    });
    const pack = packWith({
      sql_conn: { dialect: "postgres", connection_string_env: "SQL_URL" },
      tasks: [{
        id: "integrity",
        title: "Integrity",
        allowed_surfaces: ["cli"],
        oracles: [{
          type: "roundtrip",
          sqlQuery: "SELECT count(*) AS count FROM rows_{ns} WHERE id = '{row_id}'",
          assertField: "0.count",
          expected: 1,
          probeSqlQuery: "INSERT duplicate_probe INTO rows_{ns}",
          probeAssertField: "code",
          probeExpected: "23505",
          probeExpectError: true,
        }],
      }],
    });

    const outcomes = await verifyGeneratedPack(
      pack,
      executor("integrity", { row_id: "r-7" }, "batch_a"),
      {} as never,
      "cli",
      undefined,
      {
        credentials: { SQL_URL: "postgres://cell-a.example.test/db" },
        oracleProviders: createOracleProviderRegistry([provider]),
      },
    );

    expect(outcomes[0]?.success).toBe(true);
    expect(outcomes[0]?.oracleResults).toEqual([
      expect.objectContaining({ type: "verifier-probe", passed: true }),
      expect.objectContaining({ type: "roundtrip", passed: true }),
    ]);
    expect(calls).toEqual([
      {
        connection: { dialect: "postgres", connectionString: "postgres://cell-a.example.test/db" },
        query: "INSERT duplicate_probe INTO rows_batch_a",
      },
      {
        connection: { dialect: "postgres", connectionString: "postgres://cell-a.example.test/db" },
        query: "SELECT count(*) AS count FROM rows_batch_a WHERE id = 'r-7'",
      },
    ]);
  });

  it("uses a namespace-safe role and requires a real driver error for error assertions", async () => {
    const calls: Array<{ query: string; role: string | undefined }> = [];
    const pack = packWith({
      sql_conn: { dialect: "postgres", connection_string_env: "SQL_URL" },
      tasks: [{
        id: "access",
        title: "Access",
        allowed_surfaces: ["cli"],
        oracles: [{
          type: "roundtrip",
          sqlQuery: "SELECT secret FROM protected",
          sqlRoleTemplate: "denied_role_{ns}",
          assertOutcome: "error",
          assertField: "code",
          expected: "42501",
        }],
      }],
    });
    const registry = createOracleProviderRegistry([
      createSqlOracleProvider(async (_connection, query, role) => {
        calls.push({ query, role });
        return { code: "42501", message: "permission denied" };
      }),
    ]);

    const outcomes = await verifyGeneratedPack(
      pack,
      executor("access", {}, "role-with-dashes"),
      {} as never,
      "cli",
      undefined,
      {
        credentials: { SQL_URL: "postgres://admin.example.test/db" },
        oracleProviders: registry,
      },
    );

    expect(outcomes[0]?.success).toBe(true);
    expect(calls).toEqual([{
      query: "SELECT secret FROM protected",
      role: "denied_role_role_with_dashes",
    }]);
  });

  it("uses an executor-reported alternate connection without reading ambient env", async () => {
    const connections: SqlConnection[] = [];
    const pack = packWith({
      tasks: [{
        id: "restore",
        title: "Restore",
        allowed_surfaces: ["cli"],
        oracles: [{
          type: "roundtrip",
          sqlDialect: "mysql",
          sqlQuery: "SELECT 1 AS ok",
          sqlConnField: "restored_connection",
          assertField: "0.ok",
          expected: 1,
        }],
      }],
    });
    const registry = createOracleProviderRegistry([
      createSqlOracleProvider(async (connection) => {
        connections.push(connection);
        return [{ ok: 1 }];
      }),
    ]);

    const outcomes = await verifyGeneratedPack(
      pack,
      executor("restore", { restored_connection: "mysql://reported.example.test/db" }),
      {} as never,
      "cli",
      undefined,
      { env: {}, oracleProviders: registry },
    );

    expect(outcomes[0]?.success).toBe(true);
    expect(connections).toEqual([{
      dialect: "mysql",
      connectionString: "mysql://reported.example.test/db",
    }]);
  });

  it("contains and redacts unexpected runner failures through the core provider boundary", async () => {
    const pack = packWith({
      sql_conn: { dialect: "postgres", connection_string_env: "SQL_URL" },
      tasks: [{
        id: "driver-failure",
        title: "Driver failure",
        allowed_surfaces: ["cli"],
        oracles: [{
          type: "roundtrip",
          sqlQuery: "SELECT 1",
          assertField: "0.value",
          expected: 1,
        }],
      }],
    });
    const registry = createOracleProviderRegistry([
      createSqlOracleProvider(async () => {
        throw new Error("dial failed for postgres://admin:super-secret@example.test/db");
      }),
    ]);

    const outcomes = await verifyGeneratedPack(
      pack,
      executor("driver-failure"),
      {} as never,
      "cli",
      undefined,
      {
        credentials: { SQL_URL: "postgres://admin:super-secret@example.test/db" },
        oracleProviders: registry,
      },
    );

    expect(outcomes[0]?.success).toBe(false);
    expect(outcomes[0]?.oracleResults[0]?.detail).toBe('oracle provider "arena-sql" failed');
    expect(JSON.stringify(outcomes)).not.toContain("super-secret");
  });

  it("runs PostgreSQL role setup and verification as separate statements", async () => {
    postgresDriver.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ value: 1 }] });

    const result = await runSqlQuery(
      { dialect: "postgres", connectionString: "postgres://cell.example.test/db" },
      "SELECT 1 AS value",
      "verified_role",
    );

    expect(result).toEqual([{ value: 1 }]);
    expect(postgresDriver.query.mock.calls).toEqual([
      ["RESET ROLE"],
      ['SET ROLE "verified_role"'],
      ["SELECT 1 AS value"],
    ]);
  });
});

describe("arena Mongo oracle provider", () => {
  it("renders nested namespace, gid, reported, and explicit credential templates", async () => {
    const calls: Array<{ connection: MongoConnection; query: MongoQuery }> = [];
    const pack = packWith({
      mongo_conn: { connection_string_env: "MONGO_URL", database: "default_db" },
      tasks: [{
        id: "mongo-state",
        title: "Mongo state",
        allowed_surfaces: ["cli"],
        oracles: [{
          type: "roundtrip",
          mongoQuery: {
            database: "db_{ns}",
            collection: "items_${COLLECTION_SUFFIX}",
            operation: "count",
            filter: { _id: "{gid}", owner: "{owner_id}" },
          },
          assertField: "count",
          expected: 1,
        }],
      }],
    });
    const registry = createOracleProviderRegistry([
      createMongoOracleProvider(async (connection, query) => {
        calls.push({ connection, query });
        return { count: 1 };
      }),
    ]);

    const outcomes = await verifyGeneratedPack(
      pack,
      executor("mongo-state", { gid: "doc-1", owner_id: "owner-2" }, "batch_3"),
      {} as never,
      "cli",
      undefined,
      {
        credentials: {
          MONGO_URL: "mongodb://cell.example.test/db",
          COLLECTION_SUFFIX: "verified",
        },
        oracleProviders: registry,
      },
    );

    expect(outcomes[0]?.success).toBe(true);
    expect(calls).toEqual([{
      connection: {
        connectionString: "mongodb://cell.example.test/db",
        database: "default_db",
      },
      query: {
        database: "db_batch_3",
        collection: "items_verified",
        operation: "count",
        filter: { _id: "doc-1", owner: "owner-2" },
      },
    }]);
  });

  it("keeps concurrent cell credentials isolated", async () => {
    const seen: string[] = [];
    const pack = packWith({
      mongo_conn: { connection_string_env: "MONGO_URL" },
      tasks: [{
        id: "mongo-isolation",
        title: "Mongo isolation",
        allowed_surfaces: ["cli"],
        oracles: [{
          type: "roundtrip",
          mongoQuery: {
            database: "db",
            collection: "items",
            operation: "count",
          },
          assertField: "count",
          expected: 1,
        }],
      }],
    });
    const registry = createOracleProviderRegistry([
      createMongoOracleProvider(async (connection) => {
        seen.push(connection.connectionString);
        return { count: 1 };
      }),
    ]);

    const [cellA, cellB] = await Promise.all([
      verifyGeneratedPack(pack, executor("mongo-isolation"), {} as never, "cli", undefined, {
        credentials: { MONGO_URL: "mongodb://cell-a.example.test/db" },
        oracleProviders: registry,
      }),
      verifyGeneratedPack(pack, executor("mongo-isolation"), {} as never, "cli", undefined, {
        credentials: { MONGO_URL: "mongodb://cell-b.example.test/db" },
        oracleProviders: registry,
      }),
    ]);

    expect(cellA[0]?.success).toBe(true);
    expect(cellB[0]?.success).toBe(true);
    expect(seen).toEqual(expect.arrayContaining([
      "mongodb://cell-a.example.test/db",
      "mongodb://cell-b.example.test/db",
    ]));
  });
});
