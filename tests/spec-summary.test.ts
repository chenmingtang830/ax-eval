import { describe, expect, it } from "vitest";
import { summarizeOpenApiText } from "../src/ingest/spec-summary.js";

describe("summarizeOpenApiText", () => {
  it("lists every OpenAPI HTTP method in deterministic tag/path order", () => {
    const spec = JSON.stringify({
      info: { title: "Demo Admin API" },
      paths: {
        "/z": {
          trace: { operationId: "traceZ", tags: ["Zed"] },
          head: { summary: "Inspect Z", tags: ["Zed"] },
        },
        "/projects": {
          options: { description: "Describe\nproject options", tags: ["Projects"] },
          get: { summary: "List projects", tags: ["Projects"] },
          post: { summary: "Create a project", tags: ["Projects"] },
        },
      },
    });
    const summary = summarizeOpenApiText(spec, "fixture.json");
    expect(summary.title).toBe("Demo Admin API");
    expect(summary.operationCount).toBe(5);
    expect(summary.text.split("\n")).toEqual([
      "[tag \"Projects\"]",
      "- method=GET path=\"/projects\" summary=\"List projects\"",
      "- method=OPTIONS path=\"/projects\" summary=\"Describe project options\"",
      "- method=POST path=\"/projects\" summary=\"Create a project\"",
      "[tag \"Zed\"]",
      "- method=HEAD path=\"/z\" summary=\"Inspect Z\"",
      "- method=TRACE path=\"/z\" summary=\"traceZ\"",
    ]);
  });

  it("produces the same capped summary regardless of path insertion order", () => {
    const first = JSON.stringify({ paths: {
      "/b": { get: { summary: "B", tags: ["T"] } },
      "/a": { get: { summary: "A", tags: ["T"] } },
    } });
    const second = JSON.stringify({ paths: {
      "/a": { get: { summary: "A", tags: ["T"] } },
      "/b": { get: { summary: "B", tags: ["T"] } },
    } });
    expect(summarizeOpenApiText(first, "src", 1)).toEqual(summarizeOpenApiText(second, "src", 1));
    expect(summarizeOpenApiText(first, "src", 1)).toMatchObject({ operationCount: 2, truncated: true });
  });

  it("parses YAML and sanitizes prompt-facing metadata", () => {
    const summary = summarizeOpenApiText([
      "info:",
      "  title: 'YAML   API'",
      "paths:",
      "  /things:",
      "    get:",
      "      description: |",
      "        list things",
      "        with details",
      "      tags: ['Things  and  Stuff']",
    ].join("\n"), "fixture.yaml");
    expect(summary.title).toBe("YAML API");
    expect(summary.text).toContain("[tag \"Things and Stuff\"]");
    expect(summary.text).toContain('summary="list things with details"');
  });

  it("rejects malformed roots, invalid paths shapes, and invalid limits", () => {
    expect(() => summarizeOpenApiText("[1,2]", "src")).toThrow(/root must be an object/);
    expect(() => summarizeOpenApiText("paths: []", "src")).toThrow(/paths must be an object/);
    expect(() => summarizeOpenApiText("{ nope", "src")).toThrow(/not valid JSON or YAML/);
    expect(() => summarizeOpenApiText("{}", "src", 0)).toThrow(/positive integer/);
  });
});
