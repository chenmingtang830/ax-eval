import { describe, expect, it } from "vitest";
import { TraceReviewMemoSchema } from "../src/authoring/artifact-contracts.js";

describe("arena artifact contracts", () => {
  it("requires explicit reviewer metadata and a full sample before trace review completion", () => {
    expect(TraceReviewMemoSchema.safeParse({
      schema: "ax.trace-review/v1",
      benchmark: "DAEB-1",
      generated_at: "2026-01-01T00:00:00.000Z",
      status: "completed",
      sample_size: 2,
      sample_ids: ["trace-1"],
      findings: [],
      summary: "Reviewed.",
    }).success).toBe(false);

    expect(TraceReviewMemoSchema.safeParse({
      schema: "ax.trace-review/v1",
      benchmark: "DAEB-1",
      generated_at: "2026-01-01T00:00:00.000Z",
      status: "completed",
      sample_size: 2,
      sample_ids: ["trace-1", "trace-2"],
      reviewer: "Reviewer",
      reviewed_at: "2026-01-01T01:00:00.000Z",
      commit_sha: "abcdef123456",
      findings: ["No blocker."],
      summary: "Reviewed.",
    }).success).toBe(true);
  });
});
