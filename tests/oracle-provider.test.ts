import { afterEach, describe, expect, it } from "vitest";
import {
  clearOracleProviders,
  registerOracleProvider,
  type OracleVerifyContext,
} from "../src/generate/oracle-provider.js";
import { verifyGeneratedPack, type ExecutorResults } from "../src/generate/verify.js";
import { HttpApiError } from "../src/http/client.js";
import type { OracleSpec, TargetPack } from "../src/schemas.js";

const pack: TargetPack = {
  name: "t",
  version: "0",
  standard_set_version: "gen-test",
  generated_by: "deterministic@no-model",
  auth_method: "pat",
  base_url: "https://api.example/1.0",
  response_envelope: "data",
  site_url: "",
  docs_urls: [],
  tasks: [
    {
      id: "db-sql-task",
      title: "sql",
      prompt: "",
      difficulty: "L1",
      allowed_surfaces: ["api", "docs"],
      depends_on: [],
      oracles: [
        {
          type: "roundtrip",
          description: "",
          sqlQuery: "SELECT name FROM t WHERE id = {gid}",
          assertField: "name",
          expected: "hello",
        },
      ],
    },
    {
      id: "http-task",
      title: "http",
      prompt: "",
      difficulty: "L1",
      allowed_surfaces: ["api", "docs"],
      depends_on: [],
      oracles: [
        {
          type: "roundtrip",
          description: "",
          readPathTemplate: "/tasks/{gid}",
          responseEnvelope: "data",
          assertField: "name",
          expected: "hello",
        },
      ],
    },
  ],
};

// Fake client: returns the (already-unwrapped) resource body by gid.
function fakeClient(store: Record<string, Record<string, unknown>>) {
  return {
    async get(path: string) {
      const body = store[path] ?? store[path.split("/").pop()!];
      if (!body) throw new HttpApiError(`GET ${path}: not found`, 404, {});
      return body;
    },
  } as unknown as import("../src/http/client.js").BearerClient;
}

const matchesSql = (oracle: OracleSpec) => typeof oracle.sqlQuery === "string";

afterEach(() => clearOracleProviders());

describe("oracle providers", () => {
  it("delegates matched oracles to the provider and leaves HTTP oracles to core", async () => {
    const seen: OracleVerifyContext[] = [];
    registerOracleProvider({
      id: "sql",
      matches: matchesSql,
      async verify(oracle, ctx) {
        seen.push(ctx);
        return { type: oracle.type, passed: true, detail: "sql read-back ok" };
      },
    });
    const exec: ExecutorResults = {
      profile: "ceiling",
      ns: "ns-1",
      results: { "db-sql-task": { gid: "7" }, "http-task": { gid: "1" } },
    };
    const trace = [{ step: 1, taskId: "db-sql-task", action: "query" }];
    const out = await verifyGeneratedPack(pack, exec, fakeClient({ "1": { name: "hello" } }), undefined, trace);

    const sql = out.find((o) => o.taskId === "db-sql-task")!;
    expect(sql.success).toBe(true);
    expect(sql.oracleResults[0]!.detail).toBe("sql read-back ok");
    // Provider got the full context: pack, task, reported ids, and namespace.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pack.name).toBe("t");
    expect(seen[0]!.task.id).toBe("db-sql-task");
    expect(seen[0]!.reported).toEqual({ gid: "7" });
    expect(seen[0]!.ns).toBe("ns-1");
    expect(seen[0]!.trace).toEqual(trace);
    // The plain HTTP oracle still went through the built-in round-trip path.
    const http = out.find((o) => o.taskId === "http-task")!;
    expect(http.success).toBe(true);
  });

  it("contains a throwing provider as a failed oracle, not a crashed task", async () => {
    registerOracleProvider({
      id: "sql",
      matches: matchesSql,
      async verify() {
        throw new Error("connection refused");
      },
    });
    const exec: ExecutorResults = { profile: "floor", results: { "db-sql-task": { gid: "7" } } };
    const out = await verifyGeneratedPack(pack, exec, fakeClient({}));
    const sql = out.find((o) => o.taskId === "db-sql-task")!;
    expect(sql.success).toBe(false);
    expect(sql.error).toBeNull();
    expect(sql.oracleResults[0]!.detail).toMatch(/oracle provider "sql": connection refused/);
  });

  it("re-registering the same id replaces the provider", async () => {
    registerOracleProvider({
      id: "sql",
      matches: matchesSql,
      async verify(oracle) {
        return { type: oracle.type, passed: false, detail: "old" };
      },
    });
    registerOracleProvider({
      id: "sql",
      matches: matchesSql,
      async verify(oracle) {
        return { type: oracle.type, passed: true, detail: "new" };
      },
    });
    const exec: ExecutorResults = { profile: "floor", results: { "db-sql-task": { gid: "7" } } };
    const out = await verifyGeneratedPack(pack, exec, fakeClient({}));
    expect(out.find((o) => o.taskId === "db-sql-task")!.oracleResults[0]!.detail).toBe("new");
  });

  it("with no providers registered, behavior is unchanged", async () => {
    const exec: ExecutorResults = {
      profile: "floor",
      results: { "db-sql-task": { gid: "7" }, "http-task": { gid: "1" } },
    };
    const out = await verifyGeneratedPack(pack, exec, fakeClient({ "1": { name: "hello" } }));
    // The sql oracle has no readPathTemplate, so the built-in path reports it
    // as an incomplete roundtrip spec rather than silently passing.
    const sql = out.find((o) => o.taskId === "db-sql-task")!;
    expect(sql.success).toBe(false);
    expect(out.find((o) => o.taskId === "http-task")!.success).toBe(true);
  });
});
