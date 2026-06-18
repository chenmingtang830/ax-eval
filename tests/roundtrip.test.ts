import { describe, expect, it } from "vitest";
import { verifyGeneratedPack, type ExecutorResults } from "../src/generate/verify.js";
import { resolveDotted } from "../src/http/client.js";
import type { TargetPack } from "../src/schemas.js";
import { profileSatisfies, getProfile } from "../src/harness/profile.js";

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
      id: "gen-l1-tasks",
      title: "L1",
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
      const gid = path.split("/").pop()!;
      const body = store[gid];
      if (!body) throw new Error(`404 ${path}`);
      return body;
    },
    async post(path: string, body: unknown) {
      return { path, body };
    },
  } as unknown as import("../src/http/client.js").BearerClient;
}

describe("round-trip verification", () => {
  it("passes when the API read-back matches expected", async () => {
    const exec: ExecutorResults = { profile: "ceiling", results: { "gen-l1-tasks": { gid: "1" } } };
    const out = await verifyGeneratedPack(pack, exec, fakeClient({ "1": { name: "hello" } }));
    expect(out[0]!.success).toBe(true);
  });

  it("fails when the executor reports no id", async () => {
    const exec: ExecutorResults = { profile: "floor", results: {} };
    const out = await verifyGeneratedPack(pack, exec, fakeClient({}));
    expect(out[0]!.success).toBe(false);
    expect(out[0]!.oracleResults[0]!.detail).toMatch(/no gid/);
  });

  it("fails when the read-back value differs (not just self-report)", async () => {
    const exec: ExecutorResults = { profile: "floor", results: { "gen-l1-tasks": { gid: "9" } } };
    const out = await verifyGeneratedPack(pack, exec, fakeClient({ "9": { name: "WRONG" } }));
    expect(out[0]!.success).toBe(false);
  });

  it("verifies only the tasks that apply to the selected surface", async () => {
    const surfacePack: TargetPack = {
      ...pack,
      tasks: [
        pack.tasks[0]!,
        {
          ...pack.tasks[0]!,
          id: "gen-l1-mcp-only",
          title: "MCP only",
          allowed_surfaces: ["mcp", "docs"],
          oracles: [
            {
              ...pack.tasks[0]!.oracles[0]!,
              expected: "from-mcp",
            },
          ],
        },
      ],
    };
    const exec: ExecutorResults = {
      profile: "ceiling",
      surface: "mcp",
      results: { "gen-l1-mcp-only": { gid: "2" } },
    };
    const out = await verifyGeneratedPack(surfacePack, exec, fakeClient({ "2": { name: "from-mcp" } }), "mcp");
    expect(out.map((row) => row.taskId)).toEqual(["gen-l1-mcp-only"]);
    expect(out[0]!.success).toBe(true);
  });

  it("substitutes the executor's ns into a {ns} expected before comparing", async () => {
    const nsPack: TargetPack = {
      ...pack,
      tasks: [
        {
          ...pack.tasks[0]!,
          oracles: [{ ...pack.tasks[0]!.oracles[0]!, expected: "AX probe tasks {ns}" }],
        },
      ],
    };
    const exec: ExecutorResults = {
      profile: "ceiling",
      ns: "joaufx-ceiling-ab12",
      results: { "gen-l1-tasks": { gid: "1" } },
    };
    const pass = await verifyGeneratedPack(nsPack, exec, fakeClient({ "1": { name: "AX probe tasks joaufx-ceiling-ab12" } }));
    expect(pass[0]!.success).toBe(true);

    // A different ns must NOT match (each harness is isolated).
    const other: ExecutorResults = { ...exec, ns: "joaufx-floor-zz99" };
    const fail = await verifyGeneratedPack(nsPack, other, fakeClient({ "1": { name: "AX probe tasks joaufx-ceiling-ab12" } }));
    expect(fail[0]!.success).toBe(false);
  });

  it("can verify stateless REST APIs by POSTing a read-back body with the reported gid", async () => {
    const postPack: TargetPack = {
      ...pack,
      response_envelope: undefined,
      tasks: [
        {
          ...pack.tasks[0]!,
          oracles: [
            {
              type: "roundtrip",
              description: "",
              readMethod: "POST",
              readPathTemplate: "/contents",
              readBodyTemplate: { urls: ["{gid}"], text: false },
              assertField: "body.urls.0",
              expected: "https://example.com/guide",
            },
          ],
        },
      ],
    };
    const exec: ExecutorResults = {
      profile: "ceiling",
      results: { "gen-l1-tasks": { gid: "https://example.com/guide" } },
    };
    const out = await verifyGeneratedPack(postPack, exec, fakeClient({}));
    expect(out[0]!.success).toBe(true);
  });

  it("can match URL oracles against normalized aliases", async () => {
    const urlPack: TargetPack = {
      ...pack,
      response_envelope: undefined,
      tasks: [
        {
          ...pack.tasks[0]!,
          oracles: [
            {
              type: "roundtrip",
              description: "",
              readMethod: "POST",
              readPathTemplate: "/contents",
              readBodyTemplate: { urls: ["{gid}"], text: false },
              assertField: "body.urls.0",
              expected: "https://nodejs.org/api/fs.html",
              expectedAny: ["https://nodejs.org/docs/latest-v26.x/api/fs.html"],
              matchMode: "url",
            },
          ],
        },
      ],
    };
    const exec: ExecutorResults = {
      profile: "ceiling",
      results: { "gen-l1-tasks": { gid: "https://nodejs.org/docs/latest-v26.x/api/fs.html#promises-api" } },
    };
    const out = await verifyGeneratedPack(urlPack, exec, fakeClient({}));
    expect(out[0]!.success).toBe(true);
  });
});

describe("resolveDotted", () => {
  it("walks nested objects", () => {
    expect(resolveDotted({ a: { b: { c: 3 } } }, "a.b.c")).toBe(3);
    expect(resolveDotted({ a: 1 }, "a.b")).toBeUndefined();
  });
});

describe("harness profiles", () => {
  it("a profile must cover every surface a task allows", () => {
    expect(profileSatisfies(getProfile("ceiling"), ["docs", "api"])).toBe(true);
    expect(profileSatisfies(getProfile("floor"), ["docs", "mcp"])).toBe(false);
    expect(profileSatisfies(getProfile("floor"), ["docs", "api", "sdk", "mcp", "cli"])).toBe(false);
    expect(profileSatisfies(getProfile("floor"), [])).toBe(true);
  });
});
