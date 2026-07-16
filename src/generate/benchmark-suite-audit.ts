import type { BenchmarkLayout } from "./benchmark-paths.js";
import { loadCoverageSelectionPath } from "./coverage.js";
import { auditSuite, type SuiteAuditFinding } from "./suite-audit.js";
import { loadOptionalSuitePath } from "./suite.js";

export type BenchmarkSuiteArtifact = "suite" | "coverage-selection";

export type BenchmarkSuiteAuditFinding =
  | {
      scope: "benchmark";
      severity: "error";
      code: "benchmark_suite_artifact_missing";
      artifact: BenchmarkSuiteArtifact;
      message: string;
    }
  | (SuiteAuditFinding & { scope: "suite" });

export interface BenchmarkSuiteAuditResult {
  status: "pass" | "warn" | "fail";
  findings: BenchmarkSuiteAuditFinding[];
}

export function auditBenchmarkSuite(layout: BenchmarkLayout): BenchmarkSuiteAuditResult {
  const artifactPaths: Record<BenchmarkSuiteArtifact, string> = {
    suite: layout.suite_path,
    "coverage-selection": layout.suite_coverage_selection_path,
  };
  const suite = loadOptionalSuitePath(artifactPaths.suite);
  const selection = loadCoverageSelectionPath(artifactPaths["coverage-selection"]);
  const loaded = { suite, "coverage-selection": selection };
  const missing = (Object.keys(artifactPaths) as BenchmarkSuiteArtifact[])
    .filter((artifact) => !loaded[artifact]);
  if (missing.length > 0) {
    return {
      status: "fail",
      findings: missing.map((artifact) => ({
        scope: "benchmark",
        severity: "error",
        code: "benchmark_suite_artifact_missing",
        artifact,
        message: `Required ${artifact} is missing at ${artifactPaths[artifact]}`,
      })),
    };
  }

  const findings = auditSuite({ suite: suite!, selection: selection! })
    .map((finding): BenchmarkSuiteAuditFinding => ({ ...finding, scope: "suite" }));
  const status = findings.some((finding) => finding.severity === "error")
    ? "fail"
    : findings.length > 0
      ? "warn"
      : "pass";
  return { status, findings };
}
