import { describe, expect, it } from "vitest";
import { TraceReviewMemoSchema } from "../src/generate/trace-review.js";

const completedMemo = {
  schema: "ax.trace-review/v1",
  benchmark: "database-eval",
  generated_at: "2026-07-16T00:00:00.000Z",
  status: "completed",
  sample_size: 2,
  sample_ids: ["trace-1", "trace-2"],
  reviewer: "Reviewer",
  reviewed_at: "2026-07-16T01:00:00.000Z",
  commit_sha: "abcdef123456",
  findings: ["No blockers."],
  summary: "Reviewed the fixed trace sample.",
} as const;

describe("TraceReviewMemoSchema", () => {
  it("accepts a completed review with explicit evidence", () => {
    expect(TraceReviewMemoSchema.safeParse(completedMemo).success).toBe(true);
  });

  it("requires reviewer metadata and the full sample when completed", () => {
    expect(TraceReviewMemoSchema.safeParse({
      ...completedMemo,
      reviewer: undefined,
      sample_ids: ["trace-1"],
    }).success).toBe(false);
  });

  it("rejects duplicate sample identifiers", () => {
    expect(TraceReviewMemoSchema.safeParse({
      ...completedMemo,
      sample_ids: ["trace-1", "trace-1"],
    }).success).toBe(false);
  });
});
