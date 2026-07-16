import {
  auditBenchmarkCoverage,
  type BenchmarkCoverageAuditFinding,
  type BenchmarkCoverageAuditResult,
} from "./benchmark-coverage-audit.js";
import type { BenchmarkLayout } from "./benchmark-paths.js";
import {
  auditBenchmarkSuite,
  type BenchmarkSuiteAuditResult,
} from "./benchmark-suite-audit.js";

export interface BenchmarkSuiteAuthoringCoverageResult {
  status: BenchmarkCoverageAuditResult["status"] | "skipped";
  findings: BenchmarkCoverageAuditFinding[];
}

export interface BenchmarkSuiteAuthoringAuditResult {
  status: "pass" | "warn" | "fail";
  summary: {
    errors: number;
    warnings: number;
  };
  suite: BenchmarkSuiteAuditResult;
  coverage: BenchmarkSuiteAuthoringCoverageResult;
}

function suiteOwnedCoverageFinding(
  finding: BenchmarkCoverageAuditFinding,
  suite: BenchmarkSuiteAuditResult,
): boolean {
  if (finding.code === "benchmark_coverage_artifact_missing") {
    const suiteArtifact = finding.artifact === "suite"
      ? "suite"
      : finding.artifact === "coverage-selection"
        ? "coverage-selection"
        : null;
    return suiteArtifact !== null && suite.findings.some((suiteFinding) =>
      suiteFinding.code === "benchmark_suite_artifact_missing" && suiteFinding.artifact === suiteArtifact);
  }
  return finding.code === "benchmark_coverage_methodology_missing"
    && suite.findings.some((suiteFinding) => suiteFinding.code === "methodology_missing");
}

export function combineBenchmarkSuiteAuthoringAudits(
  suite: BenchmarkSuiteAuditResult,
  rawCoverage: BenchmarkCoverageAuditResult,
): BenchmarkSuiteAuthoringAuditResult {
  const coverageFindings = rawCoverage.findings.filter((finding) => !suiteOwnedCoverageFinding(finding, suite));
  const suppressedCoverageFindings = rawCoverage.findings.length - coverageFindings.length;
  const coverage: BenchmarkSuiteAuthoringCoverageResult = {
    status: coverageFindings.length > 0
      ? "fail"
      : suppressedCoverageFindings > 0
        ? "skipped"
        : "pass",
    findings: coverageFindings,
  };
  const findings = [...suite.findings, ...coverage.findings];
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warn").length;
  return {
    status: errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
    summary: { errors, warnings },
    suite,
    coverage,
  };
}

export function auditBenchmarkSuiteAuthoring(layout: BenchmarkLayout): BenchmarkSuiteAuthoringAuditResult {
  return combineBenchmarkSuiteAuthoringAudits(
    auditBenchmarkSuite(layout),
    auditBenchmarkCoverage(layout),
  );
}
