import { describe, expect, it } from "vitest";
import { auditBenchmarkTraceReview } from "../src/generate/benchmark-trace-review-audit.js";
import { useBenchmarkTestLayout } from "./fixtures/benchmark-layout.js";

const { layout, writeYaml } = useBenchmarkTestLayout("ax-benchmark-trace-review-");

function memo(status: "pending" | "completed") {
  return {
    schema: "ax.trace-review/v1",
    benchmark: "database-eval",
    generated_at: "2026-07-16T00:00:00.000Z",
    status,
    sample_size: 2,
    sample_ids: status === "completed" ? ["trace-1", "trace-2"] : ["trace-1"],
    reviewer: status === "completed" ? "Reviewer" : undefined,
    reviewed_at: status === "completed" ? "2026-07-16T01:00:00.000Z" : undefined,
    commit_sha: status === "completed" ? "abcdef123456" : undefined,
    findings: [],
    summary: status === "completed" ? "Reviewed." : "Review pending.",
  };
}

describe("auditBenchmarkTraceReview", () => {
  it("fails when the trace review memo is missing", () => {
    expect(auditBenchmarkTraceReview(layout())).toMatchObject({
      status: "fail",
      findings: [{ code: "trace_review_missing" }],
    });
  });

  it("fails while the fixed sample review is pending", () => {
    const benchmarkLayout = layout();
    writeYaml(benchmarkLayout.suite_trace_review_path, memo("pending"));
    expect(auditBenchmarkTraceReview(benchmarkLayout)).toMatchObject({
      status: "fail",
      findings: [{ code: "trace_review_pending" }],
    });
  });

  it("passes after a complete reviewed sample is recorded", () => {
    const benchmarkLayout = layout();
    writeYaml(benchmarkLayout.suite_trace_review_path, memo("completed"));
    expect(auditBenchmarkTraceReview(benchmarkLayout)).toEqual({ status: "pass", findings: [] });
  });
});
