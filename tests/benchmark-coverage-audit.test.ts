import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { auditBenchmarkCoverage } from "../src/generate/benchmark-coverage-audit.js";
import { buildBenchmarkLayout, type BenchmarkLayout } from "../src/generate/benchmark-paths.js";
import { createCoverageAuditArtifacts } from "./fixtures/coverage-authoring.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function layout(): BenchmarkLayout {
  const root = mkdtempSync(join(tmpdir(), "ax-benchmark-coverage-audit-"));
  directories.push(root);
  return buildBenchmarkLayout(root, "database-eval", "v1");
}

function writeYaml(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(value));
}

async function writeArtifacts(benchmarkLayout: BenchmarkLayout): Promise<void> {
  const artifacts = await createCoverageAuditArtifacts();
  writeYaml(benchmarkLayout.suite_path, artifacts.suite);
  writeYaml(benchmarkLayout.suite_concept_universe_path, artifacts.universe);
  writeYaml(benchmarkLayout.suite_coverage_selection_path, artifacts.selection);
  writeYaml(benchmarkLayout.suite_coverage_matrix_path, artifacts.matrix);
}

describe("auditBenchmarkCoverage", () => {
  it("passes aligned benchmark coverage artifacts", async () => {
    const benchmarkLayout = layout();
    await writeArtifacts(benchmarkLayout);
    expect(auditBenchmarkCoverage(benchmarkLayout)).toEqual({ status: "pass", findings: [] });
  });

  it("reports every missing artifact in deterministic order", () => {
    const benchmarkLayout = layout();
    expect(auditBenchmarkCoverage(benchmarkLayout)).toEqual({
      status: "fail",
      findings: [
        expect.objectContaining({ artifact: "suite", code: "benchmark_coverage_artifact_missing" }),
        expect.objectContaining({ artifact: "concept-universe", code: "benchmark_coverage_artifact_missing" }),
        expect.objectContaining({ artifact: "coverage-selection", code: "benchmark_coverage_artifact_missing" }),
        expect.objectContaining({ artifact: "coverage-matrix", code: "benchmark_coverage_artifact_missing" }),
      ],
    });
  });

  it("fails closed when the canonical suite has no methodology", async () => {
    const benchmarkLayout = layout();
    await writeArtifacts(benchmarkLayout);
    const artifacts = await createCoverageAuditArtifacts();
    writeYaml(benchmarkLayout.suite_path, { ...artifacts.suite, methodology: undefined });
    expect(auditBenchmarkCoverage(benchmarkLayout)).toEqual({
      status: "fail",
      findings: [expect.objectContaining({ code: "benchmark_coverage_methodology_missing" })],
    });
  });

  it("preserves coverage-scoped drift findings", async () => {
    const benchmarkLayout = layout();
    await writeArtifacts(benchmarkLayout);
    const artifacts = await createCoverageAuditArtifacts();
    artifacts.selection.selected[0] = { ...artifacts.selection.selected[0]!, title: "Changed title" };
    writeYaml(benchmarkLayout.suite_coverage_selection_path, artifacts.selection);
    expect(auditBenchmarkCoverage(benchmarkLayout)).toEqual({
      status: "fail",
      findings: [expect.objectContaining({ scope: "coverage", code: "coverage_selection_policy_drift" })],
    });
  });
});
