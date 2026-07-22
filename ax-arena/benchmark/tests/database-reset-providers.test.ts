import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EvaluationCellSchema,
  TargetPackSchema,
  type ResetContext,
  type TargetPack,
} from "ax-eval";
import {
  convexResetProvider,
  mongoDbAtlasResetProvider,
  postgresResetProvider,
  tursoResetProvider,
} from "../src/providers/database-reset.js";

const pgMock = vi.hoisted(() => ({
  tables: [] as Array<{ table_name: string }>,
  functions: [] as Array<{ proname: string; identity_arguments: string }>,
  executed: [] as string[],
}));

const mongoMock = vi.hoisted(() => ({
  collections: [] as Array<{ name: string; indexes?: Array<{ name: string }>; indexError?: boolean }>,
  dropped: [] as string[],
}));

vi.mock("pg", () => ({
  Client: class {
    async connect() {}
    async end() {}
    async query(sql: string) {
      if (sql.includes("information_schema.tables")) return { rows: pgMock.tables };
      if (sql.includes("pg_proc")) return { rows: pgMock.functions };
      pgMock.executed.push(sql);
      return { rows: [] };
    }
  },
}));

vi.mock("mongodb", () => ({
  MongoClient: class {
    async connect() {}
    async close() {}
    db(database: string) {
      return {
        listCollections: () => ({ toArray: async () => mongoMock.collections.map(({ name }) => ({ name })) }),
        collection: (collection: string) => {
          const entry = mongoMock.collections.find(({ name }) => name === collection);
          return {
            listSearchIndexes: () => ({
              toArray: async () => {
                if (entry?.indexError) throw new Error("not authorized");
                return entry?.indexes ?? [];
              },
            }),
            dropSearchIndex: async (index: string) => mongoMock.dropped.push(`${database}.${collection}/${index}`),
            drop: async () => mongoMock.dropped.push(`${database}.${collection}`),
          };
        },
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

function context(pack: TargetPack, credentials: Record<string, string>, dryRun = false): ResetContext {
  return { cell, pack, credentials, scope: {}, namespace: "ns-keep", dryRun };
}

describe("arena database reset providers", () => {
  beforeEach(() => {
    pgMock.tables = [];
    pgMock.functions = [];
    pgMock.executed = [];
    mongoMock.collections = [];
    mongoMock.dropped = [];
    vi.unstubAllGlobals();
  });

  it("plans and deletes only namespaced Postgres tables and routines", async () => {
    const pack = TargetPackSchema.parse({
      name: "neon",
      sql_conn: { dialect: "postgres", connection_string_env: "DATABASE_URL" },
      tasks: [],
    });
    pgMock.tables = [
      { table_name: "axarena_acl_ns-keep" },
      { table_name: "axarena_acl_ns-keep-2" },
      { table_name: "axarena_acl_other" },
    ];
    pgMock.functions = [{ proname: "axarena_echo_ns-keep", identity_arguments: "text" }];
    const ctx = context(pack, { DATABASE_URL: "postgres://redacted.invalid/db" });

    const plan = await postgresResetProvider.plan(ctx);
    expect(plan.resources).toHaveLength(2);
    const evidence = await postgresResetProvider.execute(plan, ctx);

    expect(evidence.errors).toEqual([]);
    expect(pgMock.executed).toEqual([
      'DROP TABLE IF EXISTS "public"."axarena_acl_ns-keep" CASCADE',
      'DROP FUNCTION IF EXISTS "public"."axarena_echo_ns-keep"(text) CASCADE',
    ]);
  });

  it("keeps MongoDB collection cleanup when Search index listing is unavailable", async () => {
    const pack = TargetPackSchema.parse({
      name: "mongodb-atlas",
      mongo_conn: { connection_string_env: "MONGO_URL", database: "axarena_eval" },
      tasks: [],
    });
    mongoMock.collections = [
      { name: "axarena_vectors_ns-keep", indexError: true },
      { name: "customer_data", indexes: [{ name: "axarena_index_ns-keep" }] },
    ];
    const ctx = context(pack, { MONGO_URL: "mongodb://redacted.invalid/db" });

    const plan = await mongoDbAtlasResetProvider.plan(ctx);
    expect(plan.resources).toEqual(["mongodb:collection:axarena_eval:axarena_vectors_ns-keep:"]);
    await mongoDbAtlasResetProvider.execute(plan, ctx);
    expect(mongoMock.dropped).toEqual(["axarena_eval.axarena_vectors_ns-keep"]);
  });

  it("uses context credentials to inventory and delete Turso tables", async () => {
    const pack = TargetPackSchema.parse({
      name: "turso",
      auth: { type: "bearer", env: "TURSO_TOKEN" },
      base_url: "https://${TURSO_DATABASE}.turso.io",
      tasks: [],
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ response: { result: { rows: [
          [{ value: "axarena_table_ns-keep" }],
          [{ value: "axarena_table_other" }],
        ] } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = context(pack, { TURSO_TOKEN: "secret", TURSO_DATABASE: "sandbox" });

    const plan = await tursoResetProvider.plan(ctx);
    expect(plan.resources).toEqual(["turso:table:axarena_table_ns-keep"]);
    const evidence = await tursoResetProvider.execute(plan, ctx);
    expect(evidence.deleted).toEqual(plan.resources);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("revalidates a Convex preview matched through previewIdentifier before deleting", async () => {
    const pack = TargetPackSchema.parse({
      name: "convex",
      base_url: "https://base-deployment.convex.cloud",
      tasks: [],
    });
    const base = { id: 1, name: "base-deployment", deploymentType: "dev", projectId: 42, isDefault: true };
    const previews = [
      {
        id: 2,
        name: "shocking-cuttlefish-911",
        deploymentType: "preview",
        projectId: 42,
        isDefault: false,
        previewIdentifier: "trial-ns-keep",
      },
      {
        id: 3,
        name: "other-cuttlefish-912",
        deploymentType: "preview",
        projectId: 42,
        isDefault: false,
        previewIdentifier: "trial-ns-keep-2",
      },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(base), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(previews), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(base), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(previews), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = context(pack, { CONVEX_TEAM_ACCESS_TOKEN: "secret" });

    const plan = await convexResetProvider.plan(ctx);
    expect(plan.resources).toEqual(["convex:preview:shocking-cuttlefish-911"]);
    const evidence = await convexResetProvider.execute(plan, ctx);
    expect(evidence.deleted).toEqual(plan.resources);
    expect(fetchMock.mock.calls[4]?.[0]).toContain("shocking-cuttlefish-911/delete");
  });

  it("rejects oversized externally supplied cleanup plans before side effects", async () => {
    const pack = TargetPackSchema.parse({ name: "turso", tasks: [] });
    const oversized = {
      summary: "forged",
      resources: Array.from({ length: 101 }, (_, index) => `turso:table:axarena_ns-keep_${index}`),
    };
    await expect(tursoResetProvider.execute(oversized, context(pack, {})))
      .rejects.toThrow(/exceeds the safety limit/);
  });
});
