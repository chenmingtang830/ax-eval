/**
 * Harness-specific transcript decoding.
 *
 * Decoders stop at a small, stable event contract. Product/surface semantics
 * (curl extraction, SDK binding detection, MCP discovery, and so on) belong in
 * transcript.ts so adding a harness cannot silently change AX scoring rules.
 */

export type TranscriptHarnessId = "claude-code" | "codex" | "opencode";

export type HarnessEvent =
  | { kind: "search"; query: string; callId?: string }
  | { kind: "fetch"; url: string; callId?: string }
  | { kind: "command"; command: string; callId?: string }
  | { kind: "file_write"; path?: string; content?: string; callId?: string }
  | {
      kind: "tool_call";
      name: string;
      input: Readonly<Record<string, unknown>>;
      callId?: string;
      /** Present for harness-native MCP calls, including an empty server id. */
      server?: string;
    }
  | {
      kind: "tool_result";
      callId: string;
      /** Harness/tool outcome only; never an HTTP status. */
      outcome?: "success" | "error";
    };

export type TranscriptDecodeIssueCode =
  | "invalid_json"
  | "unrecognized_event"
  | "malformed_event";

/**
 * Deliberately contains no source text or dynamic field values. Diagnostics can
 * therefore be persisted or logged without copying commands, tool arguments,
 * result bodies, or credentials out of the already-redacted transcript.
 */
export interface TranscriptDecodeIssue {
  code: TranscriptDecodeIssueCode;
  line: number;
  harness?: TranscriptHarnessId;
}

export interface TranscriptDecodeDiagnostics {
  /** Decoder selected for this transcript, or null when auto-detection found no harness-specific signal. */
  decoder: TranscriptHarnessId | null;
  /** Version of the stable decoder/diagnostics contract. */
  decoderVersion: 1;
  /** Non-blank input lines. */
  lines: number;
  /** Lines successfully parsed as JSON. */
  parsed: number;
  /** Lines claimed by a selected harness decoder. Zero means no compatible shape was found. */
  recognized: number;
  /** Stable events emitted across all recognized lines. */
  emitted: number;
  invalid: number;
  unrecognized: number;
  /** Malformed action blocks within otherwise recognized harness lines. */
  malformed: number;
  /** Bounded, content-free issue samples in input order. */
  issues: TranscriptDecodeIssue[];
  /** Further issues omitted after the fixed safety bound. */
  omittedIssues: number;
}

export interface TranscriptDecodeResult {
  events: HarnessEvent[];
  diagnostics: TranscriptDecodeDiagnostics;
}

export interface TranscriptDecodeOptions {
  /** Restrict decoding to one known stdout shape; auto-detects by default. */
  harness?: TranscriptHarnessId | "auto";
}

interface DecodedLine {
  harness: TranscriptHarnessId;
  events: HarnessEvent[];
  malformed: number;
}

interface TranscriptLineDecoder {
  id: TranscriptHarnessId;
  /** Harness-specific identity signal used only for whole-transcript auto-detection. */
  matches(value: Record<string, unknown>): boolean;
  decode(value: Record<string, unknown>): DecodedLine | undefined;
}

const MAX_ISSUES = 20;
const FETCH_TOOLS = new Set(["WebFetch", "open_resource", "Fetch"]);
const CLAUDE_EVENT_TYPES = new Set([
  "assistant",
  "user",
  "system",
  "result",
  "stream_event",
  "rate_limit_event",
]);
const OPENCODE_EVENT_TYPES = new Set([
  "step_start",
  "step_finish",
  "text",
  "reasoning",
  "tool_use",
  "error",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    if (typeof value[name] === "string" && value[name].length > 0) return value[name];
  }
  return undefined;
}

function optionalCallId(value: Record<string, unknown>, ...names: string[]): { callId?: string } {
  const callId = stringField(value, ...names);
  return callId ? { callId } : {};
}

function decodeClaudeToolUse(block: Record<string, unknown>): { events: HarnessEvent[]; malformed: number } {
  const name = typeof block.name === "string" ? block.name : undefined;
  const input = record(block.input);
  if (!name || !input) return { events: [], malformed: 1 };
  const id = optionalCallId(block, "id", "callID", "callId");

  if (name === "WebSearch") {
    const query = stringField(input, "query", "search_term");
    return query
      ? { events: [{ kind: "search", query, ...id }], malformed: 0 }
      : { events: [], malformed: 1 };
  }
  if (FETCH_TOOLS.has(name)) {
    const url = stringField(input, "url");
    return url
      ? { events: [{ kind: "fetch", url, ...id }], malformed: 0 }
      : { events: [], malformed: 1 };
  }
  if (name === "Shell" || name === "Bash") {
    const command = stringField(input, "command", "contents", "new_string");
    return command
      ? { events: [{ kind: "command", command, ...id }], malformed: 0 }
      : { events: [], malformed: 1 };
  }
  if (name === "Write" || name === "Edit") {
    // Claude Code uses file_path/content. The older path/contents aliases are
    // retained for already-recorded fixtures and other compatible hosts; the
    // camelCase aliases keep the stable contract ready for OpenCode decoding.
    const path = stringField(input, "file_path", "filePath", "path");
    const content = stringField(input, "command", "content", "contents", "new_string", "newString");
    if (!path && !content) return { events: [], malformed: 1 };
    return { events: [{ kind: "file_write", ...(path ? { path } : {}), ...(content ? { content } : {}), ...id }], malformed: 0 };
  }

  return { events: [{ kind: "tool_call", name, input, ...id }], malformed: 0 };
}

function decodeClaudeLine(value: Record<string, unknown>): DecodedLine | undefined {
  const message = record(value.message);
  if (!isClaudeLine(value)) return undefined;

  // Older captured/test streams omitted the top-level `type` but retained the
  // native message/content envelope. Keep those transcripts readable.

  const events: HarnessEvent[] = [];
  let malformed = 0;
  const content = message?.content;
  if (!Array.isArray(content)) return { harness: "claude-code", events, malformed };

  for (const rawBlock of content) {
    const block = record(rawBlock);
    if (!block) continue;
    if (block.type === "tool_use") {
      const decoded = decodeClaudeToolUse(block);
      events.push(...decoded.events);
      malformed += decoded.malformed;
      continue;
    }
    if (block.type === "tool_result") {
      const callId = stringField(block, "tool_use_id", "toolUseId", "callID", "callId");
      if (!callId) {
        malformed += 1;
        continue;
      }
      const isError = typeof block.is_error === "boolean" ? block.is_error : undefined;
      events.push({
        kind: "tool_result",
        callId,
        ...(isError === undefined ? {} : { outcome: isError ? "error" : "success" }),
      });
      // Tool-result content is intentionally discarded. Result bodies are not
      // needed by objective action semantics and may contain product data.
    }
  }
  return { harness: "claude-code", events, malformed };
}

function isClaudeLine(value: Record<string, unknown>): boolean {
  const type = typeof value.type === "string" ? value.type : "";
  const message = record(value.message);
  if (Array.isArray(message?.content)) return true;
  if (!CLAUDE_EVENT_TYPES.has(type)) return false;
  if (type === "system" || type === "result") return typeof value.subtype === "string";
  if (type === "stream_event") return record(value.event) !== undefined;
  if (type === "rate_limit_event") {
    return record(value.rate_limit_info) !== undefined || record(value.rateLimitInfo) !== undefined;
  }
  // `assistant` and `user` require the native message/content envelope above.
  return false;
}

const claudeDecoder: TranscriptLineDecoder = {
  id: "claude-code",
  matches: isClaudeLine,
  decode: decodeClaudeLine,
};

function isCodexEventType(type: string): boolean {
  return type === "error" || /^(?:thread|turn|item)\./.test(type);
}

function decodeCodexLine(value: Record<string, unknown>): DecodedLine | undefined {
  const type = typeof value.type === "string" ? value.type : "";
  if (!isCodexEventType(type)) return undefined;

  const events: HarnessEvent[] = [];
  let malformed = 0;
  if (type !== "item.completed") return { harness: "codex", events, malformed };

  const item = record(value.item);
  if (!item) return { harness: "codex", events, malformed: 1 };
  const itemType = typeof item.type === "string" ? item.type : "";
  const id = optionalCallId(item, "id", "call_id", "callId", "callID");

  if (itemType === "web_search") {
    const query = stringField(item, "query");
    if (!query) malformed += 1;
    else if (/^https?:\/\//i.test(query)) events.push({ kind: "fetch", url: query, ...id });
    else events.push({ kind: "search", query, ...id });
  } else if (itemType === "command_execution") {
    const command = stringField(item, "command");
    if (!command) malformed += 1;
    else events.push({ kind: "command", command, ...id });
    // exit_code/status describe the local shell action, not its HTTP response.
    // They are deliberately not emitted as tool-result or HTTP status data.
  } else if (itemType === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "";
    const name = typeof item.tool === "string" ? item.tool : "";
    if (!name) malformed += 1;
    else {
      events.push({
        kind: "tool_call",
        name,
        server,
        input: record(item.arguments) ?? {},
        ...id,
      });
    }
    // A completed MCP item may carry a result body. As with Claude tool_result,
    // the body is intentionally excluded from the stable event contract.
  }

  return { harness: "codex", events, malformed };
}

const codexDecoder: TranscriptLineDecoder = {
  id: "codex",
  matches(value) {
    const type = typeof value.type === "string" ? value.type : "";
    // `error` is shared by multiple harnesses. It is decodable once Codex is
    // selected, but must not identify a transcript as Codex on its own.
    return /^(?:thread|turn|item)\./.test(type);
  },
  decode: decodeCodexLine,
};

function decodeOpenCodeToolUse(value: Record<string, unknown>): { events: HarnessEvent[]; malformed: number } {
  const part = record(value.part);
  const state = record(part?.state);
  const name = part ? stringField(part, "tool") : undefined;
  const input = record(state?.input);
  if (!part || !state || !name || !input) return { events: [], malformed: 1 };

  const id = optionalCallId(part, "callID", "callId", "call_id", "id");
  const normalizedName = name.toLowerCase().replace(/[-_]/g, "");
  const action: HarnessEvent[] = [];
  let malformed = 0;

  if (normalizedName === "websearch") {
    const query = stringField(input, "query", "search_term");
    if (query) action.push({ kind: "search", query, ...id });
    else malformed += 1;
  } else if (normalizedName === "webfetch" || normalizedName === "fetch") {
    const url = stringField(input, "url");
    if (url) action.push({ kind: "fetch", url, ...id });
    else malformed += 1;
  } else if (normalizedName === "bash" || normalizedName === "shell") {
    const command = stringField(input, "command", "contents");
    if (command) action.push({ kind: "command", command, ...id });
    else malformed += 1;
  } else if (["write", "edit", "patch", "applypatch"].includes(normalizedName)) {
    const path = stringField(input, "filePath", "file_path", "path");
    const content = stringField(input, "content", "newString", "new_string", "patch");
    if (path || content) {
      action.push({
        kind: "file_write",
        ...(path ? { path } : {}),
        ...(content ? { content } : {}),
        ...id,
      });
    } else {
      malformed += 1;
    }
  } else {
    action.push({ kind: "tool_call", name, input, ...id });
  }

  const status = stringField(state, "status");
  if (status === "completed" || status === "error") {
    if (id.callId) {
      action.push({
        kind: "tool_result",
        callId: id.callId,
        outcome: status === "completed" ? "success" : "error",
      });
    } else {
      malformed += 1;
    }
  }
  // state.output/error/attachments and metadata.output are deliberately never
  // copied. They are product data, not objective action semantics.
  return { events: action, malformed };
}

function decodeOpenCodeLine(value: Record<string, unknown>): DecodedLine | undefined {
  const type = typeof value.type === "string" ? value.type : "";
  if (!OPENCODE_EVENT_TYPES.has(type)) return undefined;
  if (type !== "tool_use") return { harness: "opencode", events: [], malformed: 0 };
  const decoded = decodeOpenCodeToolUse(value);
  return { harness: "opencode", ...decoded };
}

const openCodeDecoder: TranscriptLineDecoder = {
  id: "opencode",
  matches(value) {
    const type = typeof value.type === "string" ? value.type : "";
    // A bare `error` event is shared with Codex and cannot identify a harness.
    return type !== "error" && OPENCODE_EVENT_TYPES.has(type);
  },
  decode: decodeOpenCodeLine,
};

// Fixed pure decoders, intentionally not a mutable process-global registry.
const DECODERS: readonly TranscriptLineDecoder[] = [codexDecoder, claudeDecoder, openCodeDecoder];

/** Decode supported harness stdout JSONL into stable events plus safe diagnostics. */
export function decodeTranscriptContent(
  text: string,
  opts: TranscriptDecodeOptions = {},
): TranscriptDecodeResult {
  const events: HarnessEvent[] = [];
  const issues: TranscriptDecodeIssue[] = [];
  let omittedIssues = 0;
  let lines = 0;
  let parsed = 0;
  let recognized = 0;
  let invalid = 0;
  let unrecognized = 0;
  let malformed = 0;

  const parsedLines: Array<{
    line: number;
    value?: Record<string, unknown>;
  }> = [];

  const addIssue = (issue: TranscriptDecodeIssue): void => {
    if (issues.length < MAX_ISSUES) issues.push(issue);
    else omittedIssues += 1;
  };

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    lines += 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
      parsed += 1;
    } catch {
      invalid += 1;
      addIssue({ code: "invalid_json", line: index + 1 });
      continue;
    }
    parsedLines.push({ line: index + 1, value: record(value) });
  }

  const explicitlySelected = opts.harness && opts.harness !== "auto"
    ? DECODERS.find((decoder) => decoder.id === opts.harness)
    : undefined;
  const selected = explicitlySelected ?? (() => {
    let best: TranscriptLineDecoder | undefined;
    let bestMatches = 0;
    for (const decoder of DECODERS) {
      const matches = parsedLines.reduce(
        (count, line) => count + (line.value && decoder.matches(line.value) ? 1 : 0),
        0,
      );
      if (matches > bestMatches) {
        best = decoder;
        bestMatches = matches;
      }
    }
    return best;
  })();

  for (const parsedLine of parsedLines) {
    const decoded = parsedLine.value ? selected?.decode(parsedLine.value) : undefined;
    if (!decoded) {
      unrecognized += 1;
      addIssue({ code: "unrecognized_event", line: parsedLine.line });
      continue;
    }
    recognized += 1;
    events.push(...decoded.events);
    malformed += decoded.malformed;
    for (let count = 0; count < decoded.malformed; count += 1) {
      addIssue({ code: "malformed_event", line: parsedLine.line, harness: decoded.harness });
    }
  }

  return {
    events,
    diagnostics: {
      decoder: selected?.id ?? null,
      decoderVersion: 1,
      lines,
      parsed,
      recognized,
      emitted: events.length,
      invalid,
      unrecognized,
      malformed,
      issues,
      omittedIssues,
    },
  };
}
