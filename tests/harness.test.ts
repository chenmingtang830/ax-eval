import { describe, expect, it } from "vitest";
import { countCodexWebToolUse, extractJsonObject } from "../src/generate/harness.js";

describe("generator harness helpers", () => {
  it("extracts JSON embedded inside fenced code blocks", () => {
    const raw = [
      "Here is the result:",
      "```json",
      '{"ok":true,"items":[1,2,3]}',
      "```",
    ].join("\n");

    expect(JSON.parse(extractJsonObject(raw))).toEqual({ ok: true, items: [1, 2, 3] });
  });

  it("normalizes YAML-shaped structured output into JSON", () => {
    const raw = [
      "capabilities:",
      "  - capability_name: schema-migration",
      "    title: Schema migration",
      "    family: migration",
    ].join("\n");

    expect(JSON.parse(extractJsonObject(raw))).toEqual({
      capabilities: [{
        capability_name: "schema-migration",
        title: "Schema migration",
        family: "migration",
      }],
    });
  });

  it("counts codex web_search events from jsonl output", () => {
    const raw = [
      JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "supabase docs rls" } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "echo hi" } }),
      JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "supabase docs migrations" } }),
    ].join("\n");

    expect(countCodexWebToolUse(raw)).toEqual({ webSearch: 2, webFetch: 0 });
  });
});
