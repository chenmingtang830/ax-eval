import { describe, expect, it } from "vitest";
import { transcriptArtifactMetrics } from "../src/harness/transcript-metrics.js";

describe("transcript artifact metrics", () => {
  it("counts OpenCode tool_use events through the stable decoder seam", () => {
    const content = [
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "bash",
          callID: "call-1",
          state: { status: "completed", input: { command: "curl https://api.example.test" } },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        part: { reason: "stop", tokens: { input: 10, output: 2 } },
      }),
    ].join("\n");

    expect(transcriptArtifactMetrics(content, "opencode")).toEqual({
      tool_call_count: 1,
      token_usage: null,
      transcript_event_count: 2,
      action_occurred: true,
    });
  });

  it("keeps Claude Code and Codex call counts normalized", () => {
    const claude = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "c1", name: "WebSearch", input: { query: "docs" } }] },
    });
    const codex = [
      JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "docs" } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "curl https://api.example.test" } }),
    ].join("\n");

    expect(transcriptArtifactMetrics(claude, "claude-code").tool_call_count).toBe(1);
    expect(transcriptArtifactMetrics(codex, "codex").tool_call_count).toBe(2);
  });
});
