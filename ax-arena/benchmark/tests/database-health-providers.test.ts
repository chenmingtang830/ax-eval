import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EvaluationCellSchema,
  TargetPackSchema,
  type HealthCheckContext,
  type TargetPack,
} from "ax-eval";
import {
  convexHealthCheckProvider,
  mongoDbAtlasHealthCheckProvider,
  postgresHealthCheckProvider,
  tursoHealthCheckProvider,
} from "../src/providers/database-health.js";

const pgMock = vi.hoisted(() => ({ tableCount: 0, functionCount: 0, roleCount: 0, connectError: false }));
const mongoMock = vi.hoisted(() => ({ collections: [] as string[] }));

vi.mock("pg", () => ({
  Client: class {
    async connect() {
      if (pgMock.connectError) throw new Error("secret connection failed");
    }
    async end() {}
    async query(sql: string) {
      if (sql.includes("information_schema.tables")) return { rows: [{ count: pgMock.tableCount }] };
      if (sql.includes("pg_proc")) return { rows: [{ count: pgMock.functionCount }] };
      if (sql.includes("pg_roles")) return { rows: [{ count: pgMock.roleCount }] };
      return { rows: [{ "?column?": 1 }] };
    }
  },
}));

vi.mock("mongodb", () => ({
  MongoClient: class {
    async connect() {}
    async close() {}
    db() {
      return {
        command: async () => ({ ok: 1 }),
        listCollections: () => ({ toArray: async () => mongoMock.collections.map((name) => ({ name })) }),
      };
    }
  },
}));

const cell = EvaluationCellSchema.parse({
  schema: "ax.evaluation-cell/v1",
  cell_id: "cell-1",
  batch_id: "batch-1",
  evaluation_set_id: "daeb",
  evaluation_set_version: "1",
  target_id: "database",
  pack: { path: "pack.yaml", content_hash: "0".repeat(64) },
  surface: "api",
  harness: { id: "codex", profile: "medium", model: "test", effort: "medium" },
  trial: 1,
  source_commit_sha: "a".repeat(40),
  required_credentials: [],
  run_context: {
    cwd: "/tmp/workspace",
    artifact_dir: "/tmp/artifacts",
    invoke_timeout_ms: 1,
    first_action_timeout_ms: 1,
    invoke_retries: 0,
  },
});

function context(pack: TargetPack, credentials: Record<string, string>): HealthCheckContext {
  return { cell, pack, credentials };
}

describe("arena database health providers", () => {
  beforeEach(() => {
    pgMock.tableCount = 0;
    pgMock.functionCount = 0;
    pgMock.roleCount = 0;
    pgMock.connectError = false;
    mongoMock.collections = [];
    vi.unstubAllGlobals();
  });

  it("reports Postgres reachability and leftover namespace pressure", async () => {
    const pack = TargetPackSchema.parse({
      name: "neon",
      sql_conn: { dialect: "postgres", connection_string_env: "DATABASE_URL" },
      tasks: [],
    });
    pgMock.tableCount = 1;
    pgMock.roleCount = 1;
    await expect(postgresHealthCheckProvider.check(context(pack, { DATABASE_URL: "secret" })))
      .resolves.toEqual([
        { status: "pass", message: "Postgres connection is reachable" },
        { status: "warn", message: "2 leftover axarena resource(s) may cause namespace pollution" },
      ]);
  });

  it("does not expose connection errors or credentials in health evidence", async () => {
    const pack = TargetPackSchema.parse({
      name: "neon",
      sql_conn: { dialect: "postgres", connection_string_env: "DATABASE_URL" },
      tasks: [],
    });
    pgMock.connectError = true;
    const evidence = await postgresHealthCheckProvider.check(context(pack, { DATABASE_URL: "top-secret" }));
    expect(evidence).toEqual([{ status: "fail", message: "Postgres health check failed" }]);
    expect(JSON.stringify(evidence)).not.toContain("top-secret");
  });

  it("pings a dedicated MongoDB database and inventories arena collections", async () => {
    const pack = TargetPackSchema.parse({
      name: "mongodb-atlas",
      mongo_conn: { connection_string_env: "MONGO_URL", database: "axarena_eval" },
      tasks: [],
    });
    mongoMock.collections = ["axarena_vectors_old", "customer_data"];
    await expect(mongoDbAtlasHealthCheckProvider.check(context(pack, { MONGO_URL: "secret" })))
      .resolves.toEqual([
        { status: "pass", message: "MongoDB connection is reachable" },
        { status: "warn", message: "1 leftover axarena resource(s) may cause namespace pollution" },
      ]);
  });

  it("checks Turso with context-only credentials", async () => {
    const pack = TargetPackSchema.parse({
      name: "turso",
      auth: { type: "bearer", env: "TURSO_TOKEN" },
      base_url: "https://${TURSO_DATABASE}.turso.io",
      tasks: [],
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [{ response: { result: { rows: [[{ value: "axarena_old" }]] } } }],
    }), { status: 200 })));
    const evidence = await tursoHealthCheckProvider.check(context(pack, {
      TURSO_TOKEN: "secret",
      TURSO_DATABASE: "sandbox",
    }));
    expect(evidence[0]).toEqual({ status: "pass", message: "Turso connection is reachable" });
    expect(evidence[1]?.status).toBe("warn");
  });

  it("accepts Turso verifier auth aliases in declared priority order", async () => {
    const pack = TargetPackSchema.parse({
      name: "turso",
      auth: {
        type: "bearer",
        env: "TURSO_TOKEN",
        env_aliases: ["TURSO_TOKEN_ALIAS"],
        verify_env: "TURSO_VERIFY_TOKEN",
        verify_env_aliases: ["TURSO_VERIFY_TOKEN_ALIAS"],
      },
      base_url: "https://${TURSO_DATABASE}.turso.io",
      tasks: [],
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      results: [{ response: { result: { rows: [] } } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const evidence = await tursoHealthCheckProvider.check(context(pack, {
      TURSO_VERIFY_TOKEN_ALIAS: "alias-secret",
      TURSO_DATABASE: "sandbox",
    }));

    expect(evidence[0]).toEqual({ status: "pass", message: "Turso connection is reachable" });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer alias-secret" });
  });

  it("warns instead of blocking Convex when optional management health is unavailable", async () => {
    const pack = TargetPackSchema.parse({ name: "convex", base_url: "https://sandbox.convex.cloud", tasks: [] });
    await expect(convexHealthCheckProvider.check(context(pack, {}))).resolves.toEqual([
      { status: "warn", message: "Convex cleanup health check is unavailable without a team access token" },
    ]);
  });
});
