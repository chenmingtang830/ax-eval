import { describe, expect, it } from "vitest";
import { parseStructuredOutput } from "../src/generate/structured-output.js";

describe("structured generator output", () => {
  it("parses JSON, fenced JSON, and YAML without a repair model", () => {
    expect(parseStructuredOutput('{"ok":true}')).toEqual({ ok: true });
    expect(parseStructuredOutput('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(parseStructuredOutput("ok: true\nitems:\n  - one\n")).toEqual({ ok: true, items: ["one"] });
  });

  it("rejects empty or unstructured output", () => {
    expect(() => parseStructuredOutput("  ")).toThrow(/empty/);
    expect(() => parseStructuredOutput("just prose")).toThrow(/structured/);
  });
});
