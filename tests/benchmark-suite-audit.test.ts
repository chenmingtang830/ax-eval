import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { buildBenchmarkLayout, type BenchmarkLayout } from "../src/generate/benchmark-paths.js";
import { auditBenchmarkSuite } from "../src/generate/benchmark-suite-audit.js";
import type { Suite } from "../src/generate/suite.js";
import { createSuiteAuditSelection, createSuiteAuditSuite } from "./fixtures/suite-authoring.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function layout(): BenchmarkLayout {
  const root = mkdtempSync(join(tmpdir(), "ax-benchmark-suite-audit-"));
  directories.push(root);
  return buildBenchmarkLayout(root, "database-eval", "v1");
}

function writeYaml(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(value));
}

function writeArtifacts(benchmarkLayout: BenchmarkLayout, candidateSuite: Suite = createSuiteAuditSuite()): void {
  writeYaml(benchmarkLayout.suite_path, candidateSuite);
  writeYaml(benchmarkLayout.suite_coverage_selection_path, createSuiteAuditSelection());
}

describe("auditBenchmarkSuite", () => {
  it("passes aligned benchmark suite artifacts", () => {
    const benchmarkLayout = layout();
    writeArtifacts(benchmarkLayout);
    expect(auditBenchmarkSuite(benchmarkLayout)).toEqual({ status: "pass", findings: [] });
  });

  it("reports every missing suite artifact in deterministic order", () => {
    const benchmarkLayout = layout();
    expect(auditBenchmarkSuite(benchmarkLayout)).toEqual({
      status: "fail",
      findings: [
        expect.objectContaining({ artifact: "suite", code: "benchmark_suite_artifact_missing" }),
        expect.objectContaining({ artifact: "coverage-selection", code: "benchmark_suite_artifact_missing" }),
      ],
    });
  });

  it("returns warn when the suite has only advisory findings", () => {
    const benchmarkLayout = layout();
    const candidate = createSuiteAuditSuite();
    candidate.tasks = candidate.tasks.map((task) => ({ ...task, difficulty: "L1" }));
    writeArtifacts(benchmarkLayout, candidate);
    expect(auditBenchmarkSuite(benchmarkLayout)).toMatchObject({
      status: "warn",
      findings: [
        { scope: "suite", severity: "warn", code: "missing_difficulty", difficulty: "L2" },
        { scope: "suite", severity: "warn", code: "missing_difficulty", difficulty: "L3" },
        { scope: "suite", severity: "warn", code: "missing_difficulty", difficulty: "L4" },
      ],
    });
  });

  it("returns fail for suite contract drift", () => {
    const benchmarkLayout = layout();
    const candidate = createSuiteAuditSuite();
    candidate.tasks[0] = { ...candidate.tasks[0]!, intent: "Create a record." };
    writeArtifacts(benchmarkLayout, candidate);
    expect(auditBenchmarkSuite(benchmarkLayout)).toMatchObject({
      status: "fail",
      findings: [{ scope: "suite", severity: "error", code: "namespace_placeholder_missing" }],
    });
  });
});
