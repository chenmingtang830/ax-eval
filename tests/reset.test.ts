import { beforeEach, describe, it, expect, vi } from "vitest";
import { resetPack, type ResetClient } from "../src/target/reset.js";
import { TargetPackSchema, type TargetPack } from "../src/schemas.js";

const mongoMock = vi.hoisted(() => ({
  collections: [] as Array<{ name: string; indexes?: Array<{ name: string }> }>,
  droppedCollections: [] as string[],
  droppedIndexes: [] as string[],
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
    mongoMock.collections = [];
    mongoMock.droppedCollections = [];
    mongoMock.droppedIndexes = [];
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
    const res = await resetPack(makePack("asana"), client, scope, {});
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
    const res = await resetPack(makePack("asana"), client, {}, {});
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
});
