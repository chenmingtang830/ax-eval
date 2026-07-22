import { afterEach, describe, expect, it } from "vitest";
import {
  clearOracleProviders,
  createOracleProviderRegistry,
  registerOracleProvider,
  type OracleProvider,
  type OracleVerifyContext,
  type VersionedOracleProvider,
} from "../src/generate/oracle-provider.js";
import { verifyGeneratedPack, type ExecutorResults } from "../src/generate/verify.js";
import { HttpApiError } from "../src/http/client.js";
import type { OracleResult, OracleSpec, TargetPack } from "../src/schemas.js";

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

function sqlProvider(id: string, detail: string): VersionedOracleProvider {
  return {
    id,
    version: "1.0.0",
    matches: matchesSql,
    async verify(oracle) {
      return { type: oracle.type, passed: true, detail };
    },
  };
}

afterEach(() => clearOracleProviders());

describe("oracle providers", () => {
  it("delegates matched oracles to the provider and leaves HTTP oracles to core", async () => {
    const seen: OracleVerifyContext[] = [];
    registerOracleProvider({
      id: "sql",
      version: "1.0.0",
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
    expect(seen[0]!.credentials).toEqual({});
    // The plain HTTP oracle still went through the built-in round-trip path.
    const http = out.find((o) => o.taskId === "http-task")!;
    expect(http.success).toBe(true);
  });

  it("contains a throwing provider as a failed oracle, not a crashed task", async () => {
    registerOracleProvider({
      id: "sql",
      version: "1.0.0",
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
    expect(sql.oracleResults[0]!.detail).toBe('oracle provider "sql" failed');
    expect(JSON.stringify(out)).not.toContain("connection refused");
  });

  it("contains matcher failures per oracle without erasing other evidence", async () => {
    registerOracleProvider({
      id: "throwing-matcher",
      version: "1.0.0",
      matches(oracle) {
        if (oracle.readPathTemplate) throw new Error("postgres://user:secret@example.test/db");
        return false;
      },
      async verify(oracle) {
        return { type: oracle.type, passed: true, detail: "unused" };
      },
    });
    const exec: ExecutorResults = {
      profile: "floor",
      results: { "db-sql-task": { gid: "7" }, "http-task": { gid: "1" } },
    };
    const out = await verifyGeneratedPack(pack, exec, fakeClient({ "1": { name: "hello" } }));
    expect(out.find((entry) => entry.taskId === "db-sql-task")!.oracleResults).not.toHaveLength(0);
    expect(out.find((entry) => entry.taskId === "http-task")!.oracleResults).toEqual([
      { type: "roundtrip", passed: false, detail: "oracle provider selection failed" },
    ]);
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("passes trace evidence independently from the observed transcript", async () => {
    const seen: OracleVerifyContext[] = [];
    registerOracleProvider({
      id: "sql",
      version: "1.0.0",
      matches: matchesSql,
      async verify(oracle, ctx) {
        seen.push(ctx);
        return { type: oracle.type, passed: true, detail: "ok" };
      },
    });
    const exec: ExecutorResults = { profile: "floor", results: { "db-sql-task": { gid: "7" } } };
    const trace = [{ step: 1, taskId: "db-sql-task", action: "query" }];
    const observedRun = {
      searches: [], urlsFetched: [], apiCalls: [], filesWritten: [], sawBearer: false,
      cliCommands: [], cliHelpInspected: false, sdkUsage: [], mcpToolCalls: [],
      mcpToolsListed: false, wireSignals: [],
    };
    await verifyGeneratedPack(pack, exec, fakeClient({}), undefined, observedRun, { trace });
    expect(seen[0]!.trace).toEqual(trace);
  });

  it("re-registering the same id replaces the provider", async () => {
    registerOracleProvider({
      id: "sql",
      version: "1.0.0",
      matches: matchesSql,
      async verify(oracle) {
        return { type: oracle.type, passed: false, detail: "old" };
      },
    });
    registerOracleProvider({
      id: "sql",
      version: "2.0.0",
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

  it("isolates explicit registries across concurrent verification calls", async () => {
    registerOracleProvider(sqlProvider("global", "global"));
    const registryA = createOracleProviderRegistry([sqlProvider("sql-a", "registry-a")]);
    const registryB = createOracleProviderRegistry([sqlProvider("sql-b", "registry-b")]);
    const exec: ExecutorResults = {
      profile: "floor",
      results: { "db-sql-task": { gid: "7" }, "http-task": { gid: "1" } },
    };

    const [outA, outB] = await Promise.all([
      verifyGeneratedPack(pack, exec, fakeClient({ "1": { name: "hello" } }), undefined, undefined, {
        oracleProviders: registryA,
      }),
      verifyGeneratedPack(pack, exec, fakeClient({ "1": { name: "hello" } }), undefined, undefined, {
        oracleProviders: registryB,
      }),
    ]);

    expect(outA.find((outcome) => outcome.taskId === "db-sql-task")!.oracleResults[0]!.detail).toBe("registry-a");
    expect(outB.find((outcome) => outcome.taskId === "db-sql-task")!.oracleResults[0]!.detail).toBe("registry-b");
  });

  it("uses an explicitly empty registry instead of ambient providers", async () => {
    registerOracleProvider(sqlProvider("global", "global"));
    const exec: ExecutorResults = { profile: "floor", results: { "db-sql-task": { gid: "7" } } };
    const out = await verifyGeneratedPack(pack, exec, fakeClient({}), undefined, undefined, {
      oracleProviders: createOracleProviderRegistry(),
    });

    expect(out[0]!.success).toBe(false);
    expect(out[0]!.oracleResults[0]!.detail).toContain("pack declares no sql_conn");
  });

  it("rejects duplicate ids and ambiguous matches", () => {
    expect(() => createOracleProviderRegistry([
      sqlProvider("sql", "first"),
      sqlProvider("sql", "second"),
    ])).toThrow(/duplicate oracle provider id/);

    const registry = createOracleProviderRegistry([
      sqlProvider("sql-a", "first"),
      sqlProvider("sql-b", "second"),
    ]);
    expect(() => registry.providerFor(pack.tasks[0]!.oracles[0]!)).toThrow(/multiple oracle providers match: sql-a, sql-b/);
  });

  it("snapshots providers and freezes provider inputs", async () => {
    let contextWasFrozen = false;
    const source: VersionedOracleProvider = {
      id: "sql",
      version: "1.0.0",
      matches: matchesSql,
      async verify(oracle, ctx) {
        contextWasFrozen = Object.isFrozen(ctx)
          && Object.isFrozen(ctx.pack)
          && Object.isFrozen(ctx.task)
          && Object.isFrozen(ctx.credentials)
          && Object.isFrozen(oracle);
        return { type: oracle.type, passed: true, detail: "snapshotted" };
      },
    };
    const registry = createOracleProviderRegistry([source]);
    source.id = "mutated";
    source.matches = () => false;

    const exec: ExecutorResults = { profile: "floor", results: { "db-sql-task": { gid: "7" } } };
    const out = await verifyGeneratedPack(pack, exec, fakeClient({}), undefined, undefined, {
      oracleProviders: registry,
    });

    expect(registry.providers.map((provider) => provider.id)).toEqual(["sql"]);
    expect(out[0]!.oracleResults[0]!.detail).toBe("snapshotted");
    expect(contextWasFrozen).toBe(true);
  });

  it("snapshots nested provider state and contains matcher failures as safe oracle failures", async () => {
    const original = {
      ...sqlProvider("stateful", "stateful"),
      state: { enabled: true },
      matches(oracle: OracleSpec) {
        return this.state.enabled && matchesSql(oracle);
      },
    };
    const stable = createOracleProviderRegistry([original]);
    original.state.enabled = false;
    expect(stable.providerFor(pack.tasks[0]!.oracles[0]!)?.id).toBe("stateful");

    const throwing = createOracleProviderRegistry([{
      ...sqlProvider("throwing", "unused"),
      matches(oracle) {
        if (matchesSql(oracle)) throw new Error("opaque-matcher-secret");
        return false;
      },
    }]);
    const exec: ExecutorResults = { profile: "floor", results: { "db-sql-task": { gid: "7" } } };
    const out = await verifyGeneratedPack(pack, exec, fakeClient({}), undefined, undefined, {
      oracleProviders: throwing,
    });
    expect(out[0]!.oracleResults[0]!.detail).toBe("oracle provider selection failed");
    expect(JSON.stringify(out)).not.toContain("opaque-matcher-secret");
  });

  it("passes only explicit verifier credentials and scrubs them from provider evidence", async () => {
    let received: OracleVerifyContext["credentials"] | undefined;
    const registry = createOracleProviderRegistry([{
      id: "credential-probe",
      version: "1.0.0",
      matches: matchesSql,
      async verify(oracle, ctx) {
        received = ctx.credentials;
        return {
          type: ctx.credentials.DATABASE_URL!,
          passed: true,
          detail: `connected with ${ctx.credentials.DATABASE_URL}`,
          extra: ctx.credentials.DATABASE_URL,
        } as OracleResult & { extra: string | undefined };
      },
    }]);
    const exec: ExecutorResults = { profile: "floor", results: { "db-sql-task": { gid: "7" } } };
    const out = await verifyGeneratedPack(pack, exec, fakeClient({}), undefined, undefined, {
      oracleProviders: registry,
      credentials: { DATABASE_URL: "opaque-db-secret" },
    });

    expect(received).toEqual({ DATABASE_URL: "opaque-db-secret" });
    expect(out[0]!.oracleResults[0]).toEqual({
      type: "roundtrip",
      passed: true,
      detail: "connected with <redacted>",
    });
    expect(JSON.stringify(out)).not.toContain("opaque-db-secret");
  });

  it("accepts an unversioned provider only through the deprecated global registry", async () => {
    const legacyProvider: OracleProvider = {
      id: "legacy-sql",
      matches: matchesSql,
      async verify(oracle) {
        return { type: oracle.type, passed: true, detail: "legacy compatibility" };
      },
    };
    registerOracleProvider(legacyProvider);
    expect(() => {
      // @ts-expect-error Explicit immutable registries require versioned providers.
      createOracleProviderRegistry([legacyProvider]);
    }).toThrow(/version must not be empty/);

    const exec: ExecutorResults = { profile: "floor", results: { "db-sql-task": { gid: "7" } } };
    const out = await verifyGeneratedPack(pack, exec, fakeClient({}));
    expect(out[0]!.oracleResults[0]!.detail).toBe("legacy compatibility");
  });
});
