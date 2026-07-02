import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "../src/ingest/openapi.js";
import { parseMcpToolsPayload } from "../src/ingest/mcp.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "static",
  "fixtures",
  "asana.com_openapi.json",
);

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

describe("mcp ingest", () => {
  it("normalizes tools/list responses into an MCP ingest artifact", () => {
    const ingest = parseMcpToolsPayload(
      {
        result: {
          tools: [
            {
              name: "create_issue",
              description: "Create an issue",
              inputSchema: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            },
            {
              name: "get_issue",
              description: "Read an issue by id",
              inputSchema: {
                type: "object",
                properties: { issueId: { type: "string" } },
                required: ["issueId"],
              },
            },
          ],
        },
      },
      "fixture",
      "https://mcp.example.test/mcp",
    );

    expect(ingest.schema).toBe("ax.mcp-ingest/v1");
    expect(ingest.transport).toBe("http");
    expect(ingest.tools.map((tool) => tool.name)).toEqual(["create_issue", "get_issue"]);
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
