import { describe, expect, it, vi } from "vitest";
import { resetPack, type ResetClient } from "../src/target/reset.js";
import { TargetPackSchema, type TargetPack } from "../src/schemas.js";

function makePack(name: string): TargetPack {
  return TargetPackSchema.parse({ name, base_url: "https://api.test", tasks: [] });
}

function makeDatabasePack(): TargetPack {
  return TargetPackSchema.parse({
    name: "neon",
    base_url: "https://api.test",
    sql_conn: { dialect: "postgres", connection_string_env: "DATABASE_URL" },
    tasks: [],
  });
}

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

describe("resetPack compatibility teardown", () => {
  const scope = { project_gid: "PROJ1" };

  it("deletes only AX-probe resources in the named namespace", async () => {
    const { client, deleted } = stubClient([
      { gid: "1", name: "AX probe task ns-keep" },
      { gid: "2", name: "AX probe comment ns-keep" },
      { gid: "3", name: "AX probe task ns-other" },
      { gid: "4", name: "Real user task" },
    ]);
    const result = await resetPack(makePack("asana"), client, scope, { ns: "ns-keep" });

    expect(result.supported).toBe(true);
    expect(result.candidates).toBe(2);
    expect(result.deleted.sort()).toEqual(["1", "2"]);
    expect(deleted).toEqual(["/tasks/1", "/tasks/2"]);
    expect(result.errors).toEqual([]);
  });

  it("matches every probe resource only with the programmatic broad-reset override", async () => {
    const { client } = stubClient([
      { gid: "1", name: "AX probe task ns-a" },
      { gid: "2", name: "AX probe task ns-b" },
      { gid: "3", name: "Untouched" },
    ]);
    const result = await resetPack(makePack("asana"), client, scope, { allowAllNamespaces: true });
    expect(result.candidates).toBe(2);
    expect(result.deleted).toEqual(["1", "2"]);
  });

  it("previews a dry run without deleting", async () => {
    const { client, deleted } = stubClient([{ gid: "1", name: "AX probe task ns-x" }]);
    const result = await resetPack(makePack("asana"), client, scope, { ns: "ns-x", dryRun: true });
    expect(result.deleted).toEqual(["1"]);
    expect(deleted).toEqual([]);
    expect(client.del).not.toHaveBeenCalled();
    expect(result.message).toMatch(/would delete/);
  });

  it("requires explicit providers for target-specific and database cleanup", async () => {
    for (const pack of [makePack("notion"), makeDatabasePack()]) {
      const { client } = stubClient([]);
      const result = await resetPack(pack, client, scope, { ns: "ns-x" });
      expect(result).toMatchObject({ supported: false, deleted: [], candidates: 0, errors: [] });
      expect(result.message).toMatch(/explicit ResetProvider/);
      expect(client.get).not.toHaveBeenCalled();
      expect(client.del).not.toHaveBeenCalled();
    }
  });

  it("reports a clear error when the sandbox scope lacks a container id", async () => {
    const { client } = stubClient([]);
    const result = await resetPack(makePack("asana"), client, {}, { allowAllNamespaces: true });
    expect(result.supported).toBe(true);
    expect(result.candidates).toBe(0);
    expect(result.errors[0]).toMatch(/no sandbox project id/i);
  });

  it("refuses unexpectedly broad candidate sets before deleting", async () => {
    const { client, deleted } = stubClient([
      { gid: "1", name: "AX probe task ns-x" },
      { gid: "2", name: "AX probe comment ns-x" },
    ]);
    const result = await resetPack(makePack("asana"), client, scope, { ns: "ns-x", maxCandidates: 1 });
    expect(result.candidates).toBe(2);
    expect(result.deleted).toEqual([]);
    expect(result.errors[0]).toMatch(/safety limit/);
    expect(deleted).toEqual([]);
  });

  it("redacts credentials from deletion errors", async () => {
    const secret = ["napi", "resetcredential123"].join("_");
    const client: ResetClient = {
      get: vi.fn(async () => [{ gid: "1", name: "AX probe task ns-x" }]),
      del: vi.fn(async () => { throw new Error(`Bearer ${secret}`); }),
    };
    const result = await resetPack(makePack("asana"), client, scope, { ns: "ns-x" });
    expect(result.errors[0]).not.toContain(secret);
    expect(result.errors[0]).toContain("[REDACTED]");
  });

  it("fails closed and redacts credentials when candidate listing fails", async () => {
    const secret = ["napi", "listcredential123"].join("_");
    const client: ResetClient = {
      get: vi.fn(async () => { throw new Error(`Bearer ${secret}`); }),
      del: vi.fn(async () => undefined),
    };
    const result = await resetPack(makePack("asana"), client, scope, { ns: "ns-x" });
    expect(result.deleted).toEqual([]);
    expect(result.errors[0]).not.toContain(secret);
    expect(result.errors[0]).toContain("[REDACTED]");
    expect(client.del).not.toHaveBeenCalled();
  });

  it("rejects malformed namespaces before listing candidates", async () => {
    const { client } = stubClient([]);
    const result = await resetPack(makePack("asana"), client, scope, { ns: "ns-x\nother" });
    expect(result.errors[0]).toMatch(/namespace may contain/);
    expect(client.get).not.toHaveBeenCalled();
  });
});
