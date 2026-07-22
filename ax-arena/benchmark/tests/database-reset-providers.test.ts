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
  functions: [] as Array<{ oid: number; proname: string; identity_arguments: string; drop_statement?: string }>,
  roles: [] as Array<{ rolname: string }>,
  executed: [] as string[],
  failStatements: new Set<string>(),
}));

const mongoMock = vi.hoisted(() => ({
  collections: [] as Array<{ name: string; indexes?: Array<{ name: string }>; indexError?: boolean }>,
  dropped: [] as string[],
}));

vi.mock("pg", () => ({
  Client: class {
    async connect() {}
    async end() {}
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("information_schema.tables")) return { rows: pgMock.tables };
      if (sql.includes("SELECT format")) {
        const found = pgMock.functions.find((entry) => String(entry.oid) === String(params?.[0]) && entry.proname === params?.[1]);
        return { rows: found ? [{ statement: found.drop_statement ?? `DROP FUNCTION IF EXISTS "public"."${found.proname}"(${found.identity_arguments})` }] : [] };
      }
      if (sql.includes("pg_proc")) return { rows: pgMock.functions };
      if (sql.includes("pg_roles")) return { rows: pgMock.roles };
      pgMock.executed.push(sql);
      if (pgMock.failStatements.has(sql)) throw new Error("role owns unrelated object");
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

function context(pack: TargetPack, credentials: Record<string, string>, dryRun = false, namespace = "ns-keep"): ResetContext {
  return { cell, pack, credentials, scope: {}, namespace, dryRun };
}

describe("arena database reset providers", () => {
  beforeEach(() => {
    pgMock.tables = [];
    pgMock.functions = [];
    pgMock.roles = [];
    pgMock.executed = [];
    pgMock.failStatements = new Set();
    mongoMock.collections = [];
    mongoMock.dropped = [];
    vi.unstubAllGlobals();
  });

  it("leaves a namespaced role unconfirmed instead of cascading into unrelated owned objects", async () => {
    const pack = TargetPackSchema.parse({
      name: "neon",
      sql_conn: { dialect: "postgres", connection_string_env: "DATABASE_URL" },
      tasks: [],
    });
    pgMock.roles = [{ rolname: "axarena_acl_denied_ns_keep" }];
    const statement = 'DROP ROLE IF EXISTS "axarena_acl_denied_ns_keep"';
    pgMock.failStatements.add(statement);
    const ctx = context(pack, { DATABASE_URL: "postgres://redacted.invalid/db" });
    const plan = await postgresResetProvider.plan(ctx);
    const evidence = await postgresResetProvider.execute(plan, ctx);

    expect(evidence.deleted).toEqual([]);
    expect(evidence.errors).toEqual([expect.stringContaining("failed to delete")]);
    expect(pgMock.executed).toEqual([statement]);
    expect(pgMock.executed.join(" ")).not.toContain("DROP OWNED");
  });

  it("plans and deletes only namespaced Postgres tables, routines, and roles", async () => {
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
    pgMock.functions = [{ oid: 42, proname: "axarena_echo_ns-keep", identity_arguments: "text" }];
    pgMock.roles = [
      { rolname: "axarena_acl_denied_ns_keep" },
      { rolname: "axarena_acl_denied_other" },
    ];
    const ctx = context(pack, { DATABASE_URL: "postgres://redacted.invalid/db" });

    const plan = await postgresResetProvider.plan(ctx);
    expect(plan.resources).toHaveLength(3);
    const evidence = await postgresResetProvider.execute(plan, ctx);

    expect(evidence.errors).toEqual([]);
    expect(pgMock.executed).toEqual([
      'DROP TABLE IF EXISTS "public"."axarena_acl_ns-keep"',
      'DROP FUNCTION IF EXISTS "public"."axarena_echo_ns-keep"(text)',
      'DROP ROLE IF EXISTS "axarena_acl_denied_ns_keep"',
    ]);
    expect(pgMock.executed.join(" ")).not.toContain("CASCADE");
  });

  it("never interpolates externally supplied Postgres function arguments", async () => {
    const pack = TargetPackSchema.parse({
      name: "neon",
      sql_conn: { dialect: "postgres", connection_string_env: "DATABASE_URL" },
      tasks: [],
    });
    const ctx = context(pack, { DATABASE_URL: "postgres://redacted.invalid/db" });
    await expect(postgresResetProvider.execute({
      summary: "forged",
      resources: ["postgres:function:42:axarena_echo_ns-keep:text)%3B%20DROP%20TABLE%20customer_data%3B--"],
    }, ctx)).rejects.toThrow(/invalid Postgres cleanup resource/);
    expect(pgMock.executed).toEqual([]);
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

  it("accepts the dotted namespace produced by the current gpt-5.6-terra runtime", async () => {
    const namespace = "daeb-high-batch-gpt-5.6-terra-t1";
    const pack = TargetPackSchema.parse({
      name: "turso",
      auth: { type: "bearer", env: "TURSO_TOKEN" },
      base_url: "https://${TURSO_DATABASE}.turso.io",
      tasks: [],
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ response: { result: { rows: [[{ value: `axarena_table_${namespace}` }]] } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 })));
    const ctx = context(pack, { TURSO_TOKEN: "secret", TURSO_DATABASE: "sandbox" }, false, namespace);
    const plan = await tursoResetProvider.plan(ctx);
    await expect(tursoResetProvider.execute(plan, ctx)).resolves.toMatchObject({
      deleted: [`turso:table:axarena_table_${namespace}`],
      errors: [],
    });
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
