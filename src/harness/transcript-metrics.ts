import {
  decodeTranscriptContent,
  type TranscriptHarnessId,
} from "./transcript-decoder.js";

export interface TranscriptArtifactMetrics {
  tool_call_count: number | null;
  token_usage: Record<string, number> | null;
  transcript_event_count: number | null;
  action_occurred: boolean | null;
}

function addTokenField(acc: Record<string, number>, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) acc[key] = (acc[key] ?? 0) + value;
}

function collectTokenUsage(value: unknown, acc: Record<string, number>): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  addTokenField(acc, "input_tokens", record.input_tokens ?? record.inputTokens);
  addTokenField(acc, "output_tokens", record.output_tokens ?? record.outputTokens);
  addTokenField(acc, "total_tokens", record.total_tokens ?? record.totalTokens);
  if (record.usage && record.usage !== value) collectTokenUsage(record.usage, acc);
  if (record.modelUsage && typeof record.modelUsage === "object") {
    for (const entry of Object.values(record.modelUsage as Record<string, unknown>)) collectTokenUsage(entry, acc);
  }
}

/** Normalize efficiency signals from any supported durable harness transcript.
 * Tool counts come from the stable decoder seam rather than three unrelated raw
 * JSON-shape checks, so adding a harness cannot silently report zero actions. */
export function transcriptArtifactMetrics(
  content: string,
  harness?: TranscriptHarnessId,
): TranscriptArtifactMetrics {
  const tokenUsage: Record<string, number> = {};
  let parsedLines = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      parsedLines += 1;
      collectTokenUsage(event, tokenUsage);
    } catch {
      // Non-JSON transcript lines are allowed and carry no normalized metrics.
    }
  }
  const decoded = decodeTranscriptContent(content, { harness: harness ?? "auto" });
  const toolCalls = decoded.events.filter((event) => event.kind !== "tool_result").length;
  return {
    tool_call_count: toolCalls,
    token_usage: Object.keys(tokenUsage).length ? tokenUsage : null,
    transcript_event_count: parsedLines,
    action_occurred: toolCalls > 0,
  };
}
