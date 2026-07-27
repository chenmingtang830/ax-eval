import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeTranscriptContent } from "../src/harness/transcript-decoder.js";
import {
  observedToTrace,
  parseTranscriptContentWithDiagnostics,
} from "../src/harness/transcript.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "harness-events");
const BASE = "https://app.asana.com/api/1.0";

function fixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

describe("harness transcript decoders", () => {
  it("decodes real Claude stream-json aliases and links results without their bodies", () => {
    const text = fixture("claude-code-stream.redacted.jsonl");
    const decoded = decodeTranscriptContent(text, { harness: "claude-code" });

    expect(decoded.diagnostics).toMatchObject({
      decoder: "claude-code",
      decoderVersion: 1,
      lines: 6,
      parsed: 6,
      recognized: 6,
      emitted: 4,
      invalid: 0,
      unrecognized: 0,
      malformed: 0,
    });
    expect(decoded.events).toContainEqual({
      kind: "search",
      query: "Asana API create task authorization",
      callId: "toolu-search-redacted",
    });
    expect(decoded.events).toContainEqual({
      kind: "file_write",
      path: "/workspace/run.mjs",
      content: "const token = process.env.ASANA_PAT;\nreq(\"POST\",\"/tasks\");\n",
      callId: "toolu-write-redacted",
    });
    expect(decoded.events).toContainEqual({
      kind: "tool_result",
      callId: "toolu-write-redacted",
      outcome: "success",
    });
    expect(JSON.stringify(decoded.events)).not.toContain("RESULT_BODY_MUST_NOT_SURVIVE");

    const parsed = parseTranscriptContentWithDiagnostics(text, { baseUrl: BASE });
    expect(parsed.diagnostics.recognized).toBe(6);
    expect(parsed.run.searches).toEqual(["Asana API create task authorization"]);
    expect(parsed.run.filesWritten).toEqual(["/workspace/run.mjs"]);
    expect(parsed.run.apiCalls).toEqual(expect.arrayContaining([
      { method: "POST", path: "/tasks", host: "" },
      { method: "GET", path: "/users/me", host: "app.asana.com" },
    ]));
    expect(parsed.run.sawBearer).toBe(true);
  });

  it("decodes Codex exec JSONL without turning shell status or output into HTTP evidence", () => {
    const text = fixture("codex-exec.redacted.jsonl");
    const decoded = decodeTranscriptContent(text, { harness: "codex" });

    expect(decoded.diagnostics).toMatchObject({
      decoder: "codex",
      decoderVersion: 1,
      lines: 6,
      parsed: 6,
      recognized: 6,
      emitted: 3,
      invalid: 0,
      unrecognized: 0,
      malformed: 0,
    });
    const serializedEvents = JSON.stringify(decoded.events);
    expect(serializedEvents).not.toContain("RESULT_BODY_MUST_NOT_SURVIVE");
    expect(serializedEvents).not.toContain("HTTP/2 201");
    expect(serializedEvents).not.toContain("exit_code");
    expect(serializedEvents).not.toContain('"status"');

    const parsed = parseTranscriptContentWithDiagnostics(text, {
      baseUrl: BASE,
      mcpServer: "linear",
    });
    expect(parsed.run.apiCalls).toContainEqual({
      method: "POST",
      path: "/tasks",
      host: "app.asana.com",
    });
    expect(parsed.run.mcpToolCalls).toEqual(["linear.create_issue"]);
    for (const step of observedToTrace(parsed.run)) expect(step).not.toHaveProperty("status");
  });

  it("makes incompatible input explicit with deterministic, bounded, content-free diagnostics", () => {
    const secret = "sk_live_diagnostic_secret_must_not_leak";
    const text = Array.from({ length: 25 }, (_, index) => index % 2 === 0
      ? `not-json-${index}-${secret}`
      : JSON.stringify({ type: "unsupported", payload: secret })).join("\n");
    const first = decodeTranscriptContent(text);
    const second = decodeTranscriptContent(text);

    expect(first).toEqual(second);
    expect(first.events).toEqual([]);
    expect(first.diagnostics).toMatchObject({
      lines: 25,
      parsed: 12,
      recognized: 0,
      emitted: 0,
      invalid: 13,
      unrecognized: 12,
      malformed: 0,
      omittedIssues: 5,
    });
    expect(first.diagnostics.issues).toHaveLength(20);
    expect(JSON.stringify(first.diagnostics)).not.toContain(secret);
  });

  it("supports explicit harness selection and reports malformed known actions", () => {
    const wrongHarness = decodeTranscriptContent(
      fixture("claude-code-stream.redacted.jsonl"),
      { harness: "codex" },
    );
    expect(wrongHarness.events).toEqual([]);
    expect(wrongHarness.diagnostics.recognized).toBe(0);

    const malformed = decodeTranscriptContent(JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", status: "completed", exit_code: 201 },
    }), { harness: "codex" });
    expect(malformed.events).toEqual([]);
    expect(malformed.diagnostics).toMatchObject({ recognized: 1, malformed: 1 });
    expect(malformed.diagnostics.issues).toEqual([
      { code: "malformed_event", line: 1, harness: "codex" },
    ]);
  });

  it("selects one decoder for the whole transcript and does not identify generic errors as Codex", () => {
    const genericError = JSON.stringify({ type: "error", error: "redacted" });
    const automatic = decodeTranscriptContent(genericError);
    expect(automatic.diagnostics).toMatchObject({
      decoder: null,
      recognized: 0,
      unrecognized: 1,
    });

    const explicit = decodeTranscriptContent(genericError, { harness: "codex" });
    expect(explicit.diagnostics).toMatchObject({ decoder: "codex", recognized: 1 });

    const mixed = [
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "codex-only" } }),
      JSON.stringify({ type: "assistant", message: { content: [] } }),
      JSON.stringify({ type: "result", subtype: "success", result: "redacted" }),
    ].join("\n");
    const decoded = decodeTranscriptContent(mixed);
    expect(decoded.diagnostics).toMatchObject({
      decoder: "claude-code",
      recognized: 2,
      unrecognized: 1,
    });
    expect(decoded.events).toEqual([]);
  });

  it("falls through empty legacy aliases without changing meaningful command text", () => {
    const decoded = decodeTranscriptContent(JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "toolu-alias",
          name: "Bash",
          input: { command: "", contents: "curl https://docs.example.test" },
        }],
      },
    }), { harness: "claude-code" });
    expect(decoded.events).toEqual([{
      kind: "command",
      command: "curl https://docs.example.test",
      callId: "toolu-alias",
    }]);
  });

  it("does not recognize a generic Claude-like type without its native envelope", () => {
    for (const type of ["assistant", "user", "system", "result"]) {
      const decoded = decodeTranscriptContent(JSON.stringify({ type }), { harness: "claude-code" });
      expect(decoded.diagnostics).toMatchObject({ recognized: 0, unrecognized: 1 });
    }
  });
});
