import { beforeEach, describe, it, expect, vi } from "vitest";
import { resetPack, type ResetClient } from "../src/target/reset.js";
import { TargetPackSchema, type TargetPack } from "../src/schemas.js";

const mongoMock = vi.hoisted(() => ({
  collections: [] as Array<{ name: string; indexes?: Array<{ name: string }> }>,
  droppedCollections: [] as string[],
  droppedIndexes: [] as string[],
}));

const pgMock = vi.hoisted(() => ({
  tableRows: [] as Array<{ table_name: string }>,
  functionRows: [] as Array<{ proname: string; identity_arguments: string }>,
  executed: [] as string[],
  rejectCascade: false,
  rejectFunctionCascade: false,
}));

vi.mock("mongodb", () => ({
  MongoClient: class {
    constructor(readonly connectionString: string) {}
    async connect() {}
    async close() {}
    db(database: string) {
      return {
        listCollections: () => ({
          toArray: async () => mongoMock.collections.map((collection) => ({ name: collection.name })),
        }),
        collection: (collectionName: string) => {
          const collection = mongoMock.collections.find((entry) => entry.name === collectionName);
          return {
            listSearchIndexes: () => ({
              toArray: async () => collection?.indexes ?? [],
            }),
            dropSearchIndex: async (indexName: string) => {
              mongoMock.droppedIndexes.push(`${database}.${collectionName}/searchIndex/${indexName}`);
            },
            drop: async () => {
              mongoMock.droppedCollections.push(`${database}.${collectionName}`);
            },
          };
        },
      };
    }
  },
}));

vi.mock("pg", () => ({
  Client: class {
    constructor(readonly opts: { connectionString: string }) {}
    async connect() {}
    async end() {}
    async query(sql: string) {
      if (sql.includes("information_schema.tables")) return { rows: pgMock.tableRows };
      if (sql.includes("pg_proc")) return { rows: pgMock.functionRows };
      pgMock.executed.push(sql);
      if (pgMock.rejectCascade && sql.includes("DROP TABLE") && sql.includes("CASCADE")) {
        throw new Error("DROP CASCADE is not supported");
      }
      if (pgMock.rejectFunctionCascade && sql.includes("DROP FUNCTION") && sql.includes("CASCADE")) {
        throw new Error("unimplemented: drop function cascade not supported");
      }
      return { rows: [] };
    }
  },
}));

function makePack(name: string): TargetPack {
  return TargetPackSchema.parse({ name, base_url: "https://api.test", tasks: [] });
}

function makeMongoPack(): TargetPack {
  return TargetPackSchema.parse({
    name: "mongodb-atlas",
    base_url: "https://cloud.mongodb.com",
    mongo_conn: { connection_string_env: "ATLAS_CONNECTION_STRING", database: "axarena_eval" },
    tasks: [],
  });
}

function makePostgresPack(name = "neon"): TargetPack {
  return TargetPackSchema.parse({
    name,
    base_url: "https://api.test",
    sql_conn: { dialect: "postgres", connection_string_env: "POSTGRES_TEST_URL" },
    tasks: [],
  });
}

function makeTursoPack(): TargetPack {
  return TargetPackSchema.parse({
    name: "turso",
    base_url: "https://example.turso.io",
    auth: { type: "bearer", env: "TURSO_DATABASE_AUTH_TOKEN" },
    tasks: [],
  });
}

/** Stub the get/del slice the resetter uses; record delete calls. */
function stubClient(tasks: Array<{ gid?: string; name?: string }>) {
  const deleted: string[] = [];
  const client: ResetClient = {
    get: vi.fn(async () => tasks as unknown),
    del: vi.fn(async (path: string) => {
      deleted.push(path);
    }),
  };
  return { client, deleted };
}

describe("resetPack (pass@k sandbox teardown)", () => {
  const scope = { project_gid: "PROJ1" };

  beforeEach(() => {
    delete process.env.ATLAS_CONNECTION_STRING;
    delete process.env.POSTGRES_TEST_URL;
    mongoMock.collections = [];
    mongoMock.droppedCollections = [];
    mongoMock.droppedIndexes = [];
    pgMock.tableRows = [];
    pgMock.functionRows = [];
    pgMock.executed = [];
  pgMock.rejectCascade = false;
  pgMock.rejectFunctionCascade = false;
  });

  it("deletes only AX-probe resources in the named namespace", async () => {
    const { client, deleted } = stubClient([
      { gid: "1", name: "AX probe task ns-keep" },
      { gid: "2", name: "AX probe comment ns-keep" },
      { gid: "3", name: "AX probe task ns-other" }, // different ns
      { gid: "4", name: "Real user task" }, // not a probe
    ]);
    const res = await resetPack(makePack("asana"), client, scope, { ns: "ns-keep" });

    expect(res.supported).toBe(true);
    expect(res.candidates).toBe(2);
    expect(res.deleted.sort()).toEqual(["1", "2"]);
    expect(deleted).toEqual(["/tasks/1", "/tasks/2"]);
    expect(res.errors).toEqual([]);
  });

  it("matches every probe resource when no ns is given", async () => {
    const { client } = stubClient([
      { gid: "1", name: "AX probe task ns-a" },
      { gid: "2", name: "AX probe task ns-b" },
      { gid: "3", name: "Untouched" },
    ]);
    const res = await resetPack(makePack("asana"), client, scope, { allowAllNamespaces: true });
    expect(res.candidates).toBe(2);
    expect(res.deleted).toEqual(["1", "2"]);
  });

  it("dry-run previews without calling del", async () => {
    const { client, deleted } = stubClient([{ gid: "1", name: "AX probe task ns-x" }]);
    const res = await resetPack(makePack("asana"), client, scope, { ns: "ns-x", dryRun: true });
    expect(res.deleted).toEqual(["1"]);
    expect(deleted).toEqual([]); // nothing actually deleted
    expect(client.del).not.toHaveBeenCalled();
    expect(res.message).toMatch(/would delete/);
  });

  it("degrades gracefully (supported:false, no throw) for a target without a resetter", async () => {
    const { client } = stubClient([]);
    const res = await resetPack(makePack("notion"), client, scope, {});
    expect(res.supported).toBe(false);
    expect(res.deleted).toEqual([]);
    expect(res.message).toMatch(/No reset strategy/);
    expect(client.get).not.toHaveBeenCalled();
  });

  it("reports a clear error when the sandbox scope lacks a container id", async () => {
    const { client } = stubClient([]);
    const res = await resetPack(makePack("asana"), client, {}, { allowAllNamespaces: true });
    expect(res.supported).toBe(true);
    expect(res.candidates).toBe(0);
    expect(res.errors[0]).toMatch(/no sandbox project id/i);
  });

  it("dry-runs MongoDB Atlas eval collections and search indexes only", async () => {
    process.env.ATLAS_CONNECTION_STRING = "mongodb+srv://user:pass@example.test";
    mongoMock.collections = [
      { name: "axarena_vectors_ns-keep", indexes: [{ name: "axarena_vector_index_ns-keep" }, { name: "user_index" }] },
      { name: "axarena_vectors_ns-other", indexes: [{ name: "axarena_vector_index_ns-other" }] },
      { name: "customer_data", indexes: [{ name: "axarena_vector_index_ns-keep" }] },
    ];
    const { client } = stubClient([]);

    const res = await resetPack(makeMongoPack(), client, {}, { ns: "ns-keep", dryRun: true });

    expect(res.supported).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.deleted.sort()).toEqual([
      "axarena_eval.axarena_vectors_ns-keep",
      "axarena_eval.axarena_vectors_ns-keep/searchIndex/axarena_vector_index_ns-keep",
    ]);
    expect(res.candidates).toBe(2);
    expect(mongoMock.droppedCollections).toEqual([]);
    expect(mongoMock.droppedIndexes).toEqual([]);
  });

  it("drops MongoDB Atlas eval collections and matching search indexes", async () => {
    process.env.ATLAS_CONNECTION_STRING = "mongodb+srv://user:pass@example.test";
    mongoMock.collections = [
      { name: "axarena_vectors_ns-keep", indexes: [{ name: "axarena_vector_index_ns-keep" }] },
    ];
    const { client } = stubClient([]);

    const res = await resetPack(makeMongoPack(), client, {}, { ns: "ns-keep" });

    expect(res.deleted.sort()).toEqual([
      "axarena_eval.axarena_vectors_ns-keep",
      "axarena_eval.axarena_vectors_ns-keep/searchIndex/axarena_vector_index_ns-keep",
    ]);
    expect(mongoMock.droppedIndexes).toEqual([
      "axarena_eval.axarena_vectors_ns-keep/searchIndex/axarena_vector_index_ns-keep",
    ]);
    expect(mongoMock.droppedCollections).toEqual(["axarena_eval.axarena_vectors_ns-keep"]);
  });

  it("dry-runs postgres eval tables and routines through the generic sql resetter", async () => {
    process.env.POSTGRES_TEST_URL = "postgres://user:pass@example.test/db";
    pgMock.tableRows = [
      { table_name: "axarena_acl_ns-keep" },
      { table_name: "axarena_acl_ns-other" },
    ];
    pgMock.functionRows = [
      { proname: "axarena_echo_ns-keep", identity_arguments: "" },
      { proname: "axarena_echo_ns-other", identity_arguments: "text" },
    ];
    const { client } = stubClient([]);

    const res = await resetPack(makePostgresPack("neon"), client, {}, { ns: "ns-keep", dryRun: true });

    expect(res.supported).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.deleted.sort()).toEqual([
      "public.axarena_acl_ns-keep",
      "public.axarena_echo_ns-keep()",
    ]);
    expect(pgMock.executed).toEqual([]);
  });

  it("drops postgres eval tables and routines through the generic sql resetter", async () => {
    process.env.POSTGRES_TEST_URL = "postgres://user:pass@example.test/db";
    pgMock.tableRows = [{ table_name: "axarena_acl_ns-keep" }];
    pgMock.functionRows = [{ proname: "axarena_echo_ns-keep", identity_arguments: "" }];
    const { client } = stubClient([]);

    const res = await resetPack(makePostgresPack("cockroachdb"), client, {}, { ns: "ns-keep" });

    expect(res.supported).toBe(true);
    expect(res.deleted).toEqual([
      "public.axarena_acl_ns-keep",
      "public.axarena_echo_ns-keep()",
    ]);
    expect(pgMock.executed).toEqual([
      'DROP TABLE IF EXISTS "public"."axarena_acl_ns-keep" CASCADE',
      'DROP FUNCTION IF EXISTS "public"."axarena_echo_ns-keep"() CASCADE',
    ]);
  });

  it("retries table reset without CASCADE when the database rejects it", async () => {
    process.env.POSTGRES_TEST_URL = "postgres://user:pass@example.test/db";
    pgMock.tableRows = [{ table_name: "axarena_smoke_ns-keep" }];
    pgMock.rejectCascade = true;
    const { client } = stubClient([]);

    const res = await resetPack(makePostgresPack("nile"), client, {}, { ns: "ns-keep" });

    expect(res.errors).toEqual([]);
    expect(res.deleted).toEqual(["public.axarena_smoke_ns-keep"]);
    expect(pgMock.executed).toEqual([
      'DROP TABLE IF EXISTS "public"."axarena_smoke_ns-keep" CASCADE',
      'DROP TABLE IF EXISTS "public"."axarena_smoke_ns-keep"',
    ]);
  });

  it("retries function reset without CASCADE when the database rejects it", async () => {
    process.env.POSTGRES_TEST_URL = "postgres://user:pass@example.test/db";
    pgMock.functionRows = [{ proname: "axarena_echo_ns-keep", identity_arguments: "" }];
    pgMock.rejectFunctionCascade = true;
    const { client } = stubClient([]);

    const res = await resetPack(makePostgresPack("cockroachdb"), client, {}, { ns: "ns-keep" });

    expect(res.errors).toEqual([]);
    expect(res.deleted).toEqual(["public.axarena_echo_ns-keep()"]);
    expect(pgMock.executed).toEqual([
      'DROP FUNCTION IF EXISTS "public"."axarena_echo_ns-keep"() CASCADE',
      'DROP FUNCTION IF EXISTS "public"."axarena_echo_ns-keep"()',
    ]);
  });

  it("resets namespaced Turso tables through the documented pipeline endpoint", async () => {
    process.env.TURSO_DATABASE_AUTH_TOKEN = "test-token";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ response: { result: { rows: [[{ value: "axarena_smoke_ns-keep" }], [{ value: "axarena_other" }]] } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = stubClient([]);

    const res = await resetPack(makeTursoPack(), client, {}, { ns: "ns-keep" });

    expect(res.supported).toBe(true);
    expect(res.deleted).toEqual(["axarena_smoke_ns-keep"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const dropBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(dropBody.requests[0].stmt.sql).toBe('DROP TABLE IF EXISTS "axarena_smoke_ns-keep"');
    vi.unstubAllGlobals();
  });

  it("refuses unexpectedly broad candidate sets before deleting", async () => {
    const { client, deleted } = stubClient([
      { gid: "1", name: "AX probe task ns-x" },
      { gid: "2", name: "AX probe comment ns-x" },
    ]);
    const res = await resetPack(makePack("asana"), client, scope, { ns: "ns-x", maxCandidates: 1 });
    expect(res.candidates).toBe(2);
    expect(res.deleted).toEqual([]);
    expect(res.errors[0]).toMatch(/safety limit/);
    expect(deleted).toEqual([]);
  });

  it("redacts credentials from deletion errors", async () => {
    const secret = ["napi", "resetcredential123"].join("_");
    const client: ResetClient = {
      get: vi.fn(async () => [{ gid: "1", name: "AX probe task ns-x" }]),
      del: vi.fn(async () => { throw new Error(`Bearer ${secret}`); }),
    };
    const res = await resetPack(makePack("asana"), client, scope, { ns: "ns-x" });
    expect(res.errors[0]).not.toContain(secret);
    expect(res.errors[0]).toContain("[REDACTED]");
  });

  it("fails closed and redacts credentials when candidate listing fails", async () => {
    const secret = ["napi", "listcredential123"].join("_");
    const client: ResetClient = {
      get: vi.fn(async () => { throw new Error(`Bearer ${secret}`); }),
      del: vi.fn(async () => undefined),
    };
    const res = await resetPack(makePack("asana"), client, scope, { ns: "ns-x" });
    expect(res.deleted).toEqual([]);
    expect(res.errors[0]).not.toContain(secret);
    expect(res.errors[0]).toContain("[REDACTED]");
    expect(client.del).not.toHaveBeenCalled();
  });

  it("rejects malformed namespaces before listing candidates", async () => {
    const { client } = stubClient([]);
    const res = await resetPack(makePack("asana"), client, scope, { ns: "ns-x\nother" });
    expect(res.errors[0]).toMatch(/namespace may contain/);
    expect(client.get).not.toHaveBeenCalled();
  });
});
