import type { InvokeRunResult } from "../harness/invoke.js";
import type { ProfileRun } from "./report.js";

export function invokeEfficiency(meta: Partial<InvokeRunResult>): NonNullable<ProfileRun["efficiency"]> {
  return {
    latency_ms: typeof meta.durationMs === "number" ? meta.durationMs : null,
    first_action_latency_ms: typeof meta.firstActionLatencyMs === "number" ? meta.firstActionLatencyMs : null,
    transcript_event_count: typeof meta.transcriptEventCount === "number" ? meta.transcriptEventCount : null,
    action_occurred: typeof meta.actionOccurred === "boolean" ? meta.actionOccurred : null,
    validity_status: typeof meta.validityStatus === "string" ? meta.validityStatus : null,
  };
}
