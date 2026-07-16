import type { BenchmarkLayout } from "./benchmark-paths.js";
import { loadTraceReviewPath } from "./trace-review.js";

export type BenchmarkTraceReviewFinding = {
  scope: "benchmark";
  severity: "error";
  code: "trace_review_missing" | "trace_review_pending";
  message: string;
};

export interface BenchmarkTraceReviewAuditResult {
  status: "pass" | "fail";
  findings: BenchmarkTraceReviewFinding[];
}

export function auditBenchmarkTraceReview(layout: BenchmarkLayout): BenchmarkTraceReviewAuditResult {
  const memo = loadTraceReviewPath(layout.suite_trace_review_path);
  if (!memo) {
    return {
      status: "fail",
      findings: [{
        scope: "benchmark",
        severity: "error",
        code: "trace_review_missing",
        message: `Required trace review memo is missing at ${layout.suite_trace_review_path}`,
      }],
    };
  }
  if (memo.status === "pending") {
    return {
      status: "fail",
      findings: [{
        scope: "benchmark",
        severity: "error",
        code: "trace_review_pending",
        message: `Trace review is pending (${memo.sample_ids.length}/${memo.sample_size} samples recorded)`,
      }],
    };
  }
  return { status: "pass", findings: [] };
}
