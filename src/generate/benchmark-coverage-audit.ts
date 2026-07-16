import type { BenchmarkLayout } from "./benchmark-paths.js";
import { auditCoverageArtifacts, type CoverageAuditFinding } from "./coverage-audit.js";
import {
  loadConceptUniversePath,
  loadCoverageMatrixPath,
  loadCoverageSelectionPath,
} from "./coverage.js";
import { loadOptionalSuitePath } from "./suite.js";

export type BenchmarkCoverageArtifact = "suite" | "concept-universe" | "coverage-selection" | "coverage-matrix";

export type BenchmarkCoverageAuditFinding =
  | {
      scope: "benchmark";
      severity: "error";
      code: "benchmark_coverage_artifact_missing";
      artifact: BenchmarkCoverageArtifact;
      message: string;
    }
  | {
      scope: "benchmark";
      severity: "error";
      code: "benchmark_coverage_methodology_missing";
      message: string;
    }
  | (CoverageAuditFinding & { scope: "coverage" });

export interface BenchmarkCoverageAuditResult {
  status: "pass" | "fail";
  findings: BenchmarkCoverageAuditFinding[];
}

export function auditBenchmarkCoverage(layout: BenchmarkLayout): BenchmarkCoverageAuditResult {
  const artifactPaths: Record<BenchmarkCoverageArtifact, string> = {
    suite: layout.suite_path,
    "concept-universe": layout.suite_concept_universe_path,
    "coverage-selection": layout.suite_coverage_selection_path,
    "coverage-matrix": layout.suite_coverage_matrix_path,
  };
  const suite = loadOptionalSuitePath(artifactPaths.suite);
  const universe = loadConceptUniversePath(artifactPaths["concept-universe"]);
  const selection = loadCoverageSelectionPath(artifactPaths["coverage-selection"]);
  const matrix = loadCoverageMatrixPath(artifactPaths["coverage-matrix"]);
  const loaded = { suite, "concept-universe": universe, "coverage-selection": selection, "coverage-matrix": matrix };
  const missing = (Object.keys(artifactPaths) as BenchmarkCoverageArtifact[])
    .filter((artifact) => !loaded[artifact]);
  if (missing.length > 0) {
    return {
      status: "fail",
      findings: missing.map((artifact) => ({
        scope: "benchmark",
        severity: "error",
        code: "benchmark_coverage_artifact_missing",
        artifact,
        message: `Required ${artifact} is missing at ${artifactPaths[artifact]}`,
      })),
    };
  }
  if (!suite!.methodology) {
    return {
      status: "fail",
      findings: [{
        scope: "benchmark",
        severity: "error",
        code: "benchmark_coverage_methodology_missing",
        message: `Required suite methodology is missing at ${artifactPaths.suite}`,
      }],
    };
  }

  const findings = auditCoverageArtifacts({
    universe: universe!,
    selection: selection!,
    matrix: matrix!,
    methodology: suite!.methodology,
  }).map((finding): BenchmarkCoverageAuditFinding => ({ ...finding, scope: "coverage" }));
  return { status: findings.length > 0 ? "fail" : "pass", findings };
}
