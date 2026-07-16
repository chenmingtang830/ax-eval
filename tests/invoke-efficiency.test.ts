import { describe, expect, it } from "vitest";
import { invokeEfficiency } from "../src/generate/invoke-efficiency.js";

describe("invokeEfficiency", () => {
  it("normalizes current invoke metadata", () => {
    expect(invokeEfficiency({
      durationMs: 1200,
      firstActionLatencyMs: 80,
      transcriptEventCount: 9,
      actionOccurred: true,
      validityStatus: "valid",
    })).toEqual({
      latency_ms: 1200,
      first_action_latency_ms: 80,
      transcript_event_count: 9,
      action_occurred: true,
      validity_status: "valid",
    });
  });

  it("keeps legacy or incomplete metadata nullable", () => {
    expect(invokeEfficiency({})).toEqual({
      latency_ms: null,
      first_action_latency_ms: null,
      transcript_event_count: null,
      action_occurred: null,
      validity_status: null,
    });
  });
});
