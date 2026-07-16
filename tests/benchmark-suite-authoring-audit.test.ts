import { describe, expect, it } from "vitest";
import {
  auditBenchmarkSuiteAuthoring,
  combineBenchmarkSuiteAuthoringAudits,
} from "../src/generate/benchmark-suite-authoring-audit.js";
import type { BenchmarkLayout } from "../src/generate/benchmark-paths.js";
import { useBenchmarkTestLayout } from "./fixtures/benchmark-layout.js";
import { createCoverageAuditArtifacts } from "./fixtures/coverage-authoring.js";

const { layout, writeYaml } = useBenchmarkTestLayout("ax-benchmark-suite-authoring-audit-");

async function writeArtifacts(benchmarkLayout: BenchmarkLayout): Promise<Awaited<ReturnType<typeof createCoverageAuditArtifacts>>> {
  const artifacts = await createCoverageAuditArtifacts();
  writeYaml(benchmarkLayout.suite_path, artifacts.suite);
  writeYaml(benchmarkLayout.suite_concept_universe_path, artifacts.universe);
  writeYaml(benchmarkLayout.suite_coverage_selection_path, artifacts.selection);
  writeYaml(benchmarkLayout.suite_coverage_matrix_path, artifacts.matrix);
  return artifacts;
}

describe("auditBenchmarkSuiteAuthoring", () => {
  it("passes aligned suite and coverage artifacts", async () => {
    const benchmarkLayout = layout();
    await writeArtifacts(benchmarkLayout);
    expect(auditBenchmarkSuiteAuthoring(benchmarkLayout)).toEqual({
      status: "pass",
      summary: { errors: 0, warnings: 0 },
      suite: { status: "pass", findings: [] },
      coverage: { status: "pass", findings: [] },
    });
  });

  it("reports each missing artifact once", () => {
    const benchmarkLayout = layout();
    const result = auditBenchmarkSuiteAuthoring(benchmarkLayout);
    expect(result.status).toBe("fail");
    expect(result.summary).toEqual({ errors: 4, warnings: 0 });
    expect(result.suite.findings).toEqual([
      expect.objectContaining({ artifact: "suite" }),
      expect.objectContaining({ artifact: "coverage-selection" }),
    ]);
    expect(result.coverage.findings).toEqual([
      expect.objectContaining({ artifact: "concept-universe" }),
      expect.objectContaining({ artifact: "coverage-matrix" }),
    ]);
  });

  it("marks coverage skipped when its only failure is a suite-owned prerequisite", async () => {
    const benchmarkLayout = layout();
    const artifacts = await createCoverageAuditArtifacts();
    writeYaml(benchmarkLayout.suite_concept_universe_path, artifacts.universe);
    writeYaml(benchmarkLayout.suite_coverage_selection_path, artifacts.selection);
    writeYaml(benchmarkLayout.suite_coverage_matrix_path, artifacts.matrix);
    const result = auditBenchmarkSuiteAuthoring(benchmarkLayout);
    expect(result.summary).toEqual({ errors: 1, warnings: 0 });
    expect(result.suite.findings).toEqual([expect.objectContaining({ artifact: "suite" })]);
    expect(result.coverage).toEqual({ status: "skipped", findings: [] });
  });

  it("suppresses duplicate missing-methodology findings", async () => {
    const benchmarkLayout = layout();
    const artifacts = await writeArtifacts(benchmarkLayout);
    writeYaml(benchmarkLayout.suite_path, { ...artifacts.suite, methodology: undefined });
    const result = auditBenchmarkSuiteAuthoring(benchmarkLayout);
    expect(result.summary).toEqual({ errors: 1, warnings: 0 });
    expect(result.suite.findings).toEqual([expect.objectContaining({ code: "methodology_missing" })]);
    expect(result.coverage).toEqual({ status: "skipped", findings: [] });
  });

  it("preserves suite warnings in the aggregate status", () => {
    const result = combineBenchmarkSuiteAuthoringAudits({
      status: "warn",
      findings: [{
        scope: "suite",
        severity: "warn",
        code: "missing_difficulty",
        message: "Canonical suite has no selected task at difficulty L2",
        difficulty: "L2",
      }],
    }, { status: "pass", findings: [] });
    expect(result.status).toBe("warn");
    expect(result.summary).toEqual({ errors: 0, warnings: 1 });
  });
});
