import { describe, expect, it } from "vitest";
import { summarizeOpenApiText } from "../src/ingest/spec-summary.js";

const SPEC = JSON.stringify({
  info: { title: "Demo Admin API" },
  paths: {
    "/projects": {
      get: { summary: "List projects", tags: ["Projects"] },
      post: { summary: "Create a project", tags: ["Projects"] },
    },
    "/projects/{id}/backups": {
      post: { summary: "Create a backup", tags: ["Backups"] },
    },
    "/projects/{id}": {
      delete: { operationId: "deleteProject", tags: ["Projects"] },
    },
  },
});

describe("summarizeOpenApiText", () => {
  it("lists operations grouped by tag with method + path + summary", () => {
    const s = summarizeOpenApiText(SPEC, "https://example/openapi.json");
    expect(s.title).toBe("Demo Admin API");
    expect(s.operationCount).toBe(4);
    expect(s.truncated).toBe(false);
    expect(s.text).toContain("## Backups");
    expect(s.text).toContain("- POST /projects/{id}/backups — Create a backup");
    expect(s.text).toContain("- GET /projects — List projects");
    // Falls back to operationId when no summary/description.
    expect(s.text).toContain("- DELETE /projects/{id} — deleteProject");
  });

  it("marks truncation and caps the operation list", () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) paths[`/r${i}`] = { get: { summary: `op ${i}`, tags: ["T"] } };
    const s = summarizeOpenApiText(JSON.stringify({ paths }), "src", 5);
    expect(s.operationCount).toBe(10);
    expect(s.truncated).toBe(true);
    expect(s.text).toContain("5 more operations omitted");
  });

  it("parses YAML specs too", () => {
    const yaml = [
      "info:",
      "  title: YAML API",
      "paths:",
      "  /things:",
      "    get:",
      "      summary: list things",
      "      tags: [Things]",
    ].join("\n");
    const s = summarizeOpenApiText(yaml, "src");
    expect(s.title).toBe("YAML API");
    expect(s.text).toContain("- GET /things — list things");
  });
});
