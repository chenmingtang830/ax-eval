import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "../src/ingest/openapi.js";
import { fetchSpecText } from "../src/ingest/run.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "static",
  "fixtures",
  "asana.com_openapi.json",
);

afterEach(() => vi.unstubAllGlobals());

describe("OpenAPI source fetching", () => {
  it("reports the final response URL and can refuse fixture fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      url: "https://cdn.example.test/openapi.json",
      headers: new Headers(),
      body: null,
      text: async () => "{}",
    })));
    await expect(fetchSpecText("https://docs.example.test/openapi.json", {
      allowFixtureFallback: false,
    })).resolves.toEqual({ text: "{}", source: "https://cdn.example.test/openapi.json" });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(fetchSpecText("https://docs.example.test/openapi.json", {
      allowFixtureFallback: false,
    })).rejects.toThrow(/exact spec source/);
  });

  it("rejects disallowed hosts and private DNS before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const secureOptions = {
      allowFixtureFallback: false,
      allowedRemoteRoots: ["https://docs.acme.example"],
      rejectPrivateNetwork: true,
      resolveHost: async () => ["10.0.0.8"],
    };

    await expect(fetchSpecText("https://third-party.example/openapi.json", secureOptions))
      .rejects.toThrow(/non-official host/);
    await expect(fetchSpecText("https://docs.acme.example/openapi.json", secureOptions))
      .rejects.toThrow(/private or non-routable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates every redirect before following it", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 302,
      url: "https://docs.acme.example/openapi.json",
      headers: new Headers({ location: "http://127.0.0.1/internal" }),
      body: null,
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSpecText("https://docs.acme.example/openapi.json", {
      allowFixtureFallback: false,
      allowedRemoteRoots: ["https://docs.acme.example"],
      rejectPrivateNetwork: true,
      resolveHost: async () => ["93.184.216.34"],
      fetchRemote: async (url, addresses) => {
        expect(addresses).toEqual(["93.184.216.34"]);
        return fetch(url);
      },
    })).rejects.toThrow(/non-official host|private or non-routable/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized remote and non-opted-in local sources", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("12345", {
      status: 200,
      headers: { "content-length": "5" },
    })));
    await expect(fetchSpecText("https://docs.acme.example/openapi.json", {
      allowFixtureFallback: false,
      allowedRemoteRoots: ["https://docs.acme.example"],
      rejectPrivateNetwork: true,
      resolveHost: async () => ["93.184.216.34"],
      fetchRemote: async (url, addresses) => {
        expect(addresses).toEqual(["93.184.216.34"]);
        return fetch(url);
      },
      maxBytes: 4,
    })).rejects.toThrow(/exceeds 4 bytes/);
    await expect(fetchSpecText(FIXTURE, { allowLocalFiles: false }))
      .rejects.toThrow(/explicit offline mode/);
  });
});

describe("openapi ingest", () => {
  const spec = parseSpec(readFileSync(FIXTURE, "utf8"), "fixture");

  it("reads base_url and envelope", () => {
    expect(spec.baseUrl).toBe("https://app.asana.com/api/1.0");
    expect(spec.requestEnvelope).toBe("data");
    expect(spec.responseEnvelope).toBe("data");
  });

  it("detects simple CRUD resources with read-back + identity", () => {
    const tasks = spec.resources.find((r) => r.name === "tasks");
    expect(tasks).toBeTruthy();
    expect(tasks!.createPath).toBe("/tasks");
    expect(tasks!.readPath).toBe("/tasks/{task_gid}");
    expect(tasks!.identityField).toBe("name");
    expect(tasks!.createFields).toContain("notes");
  });

  it("detects nested resource + its parent dependency", () => {
    const sections = spec.resources.find((r) => r.name === "sections");
    expect(sections).toBeTruthy();
    expect(sections!.createPath).toBe("/projects/{project_gid}/sections");
    expect(sections!.dependsOn).toContain("projects");
    expect(sections!.readPath).toBe("/sections/{section_gid}");
  });

  it("reports no auth + no constant headers when the spec declares none", () => {
    expect(spec.auth).toEqual({ type: "none", header: null });
    expect(spec.constantHeaders).toEqual({});
  });
});

describe("openapi security + constant headers", () => {
  it("parses an apiKey-in-header scheme and a constant version header", () => {
    const doc = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Demo" },
      servers: [{ url: "https://api.demo.test/v1" }],
      components: {
        securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-Demo-Key" } },
      },
      security: [{ apiKey: [] }],
      paths: {
        "/widgets": {
          parameters: [
            { name: "Demo-Version", in: "header", required: true, schema: { enum: ["2026-01-01"] } },
          ],
          post: {
            operationId: "createWidget",
            requestBody: {
              content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
            },
          },
        },
        "/widgets/{widget_id}": { get: { operationId: "getWidget" } },
      },
    });
    const spec = parseSpec(doc, "demo");
    expect(spec.auth).toEqual({ type: "api-key", header: "X-Demo-Key" });
    // The auth header is not double-counted as a constant header.
    expect(spec.constantHeaders).toEqual({ "Demo-Version": "2026-01-01" });
  });

  it("prefers the read-back identity field when it differs from the create payload", () => {
    const spec = parseSpec(
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Docs" },
        servers: [{ url: "https://api.docs.test/v1" }],
        paths: {
          "/docs": {
            post: {
              operationId: "createDoc",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { title: { type: "string" }, workspaceId: { type: "string" } },
                      required: ["title"],
                    },
                  },
                },
              },
            },
          },
          "/docs/{docId}": {
            get: {
              operationId: "getDoc",
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { id: { type: "string" }, name: { type: "string" } },
                        required: ["id", "name"],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      "docs",
    );
    expect(spec.resources.find((r) => r.name === "docs")?.identityField).toBe("name");
  });

  it("classifies http bearer + oauth2 schemes and resolves a server variable", () => {
    const bearer = parseSpec(
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "B" },
        servers: [{ url: "https://{region}.api.test", variables: { region: { default: "eu" } } }],
        components: { securitySchemes: { tok: { type: "http", scheme: "bearer" } } },
        paths: {},
      }),
      "b",
    );
    expect(bearer.auth).toEqual({ type: "bearer", header: "Authorization" });
    expect(bearer.baseUrl).toBe("https://eu.api.test");

    const oauth = parseSpec(
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "O" },
        components: { securitySchemes: { o: { type: "oauth2", flows: {} } } },
        paths: {},
      }),
      "o",
    );
    expect(oauth.auth.type).toBe("oauth");
    expect(oauth.auth.header).toBe("Authorization");
  });
});
