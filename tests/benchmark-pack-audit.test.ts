import { describe, expect, it } from "vitest";
import { auditBenchmarkPack } from "../src/generate/benchmark-pack-audit.js";
import {
  benchmarkCompiledPackPath,
  benchmarkOraclesPath,
  benchmarkSurfacesPath,
  benchmarkVendorCardPath,
  type BenchmarkLayout,
} from "../src/generate/benchmark-paths.js";
import type { TaskExtractResult } from "../src/generate/task-extract.js";
import { useBenchmarkTestLayout } from "./fixtures/benchmark-layout.js";
import {
  createPackAuthoringArtifacts,
  packAuthoringConfig,
  packAuthoringTasks,
} from "./fixtures/pack-authoring.js";

const { layout, writeYaml } = useBenchmarkTestLayout("ax-benchmark-pack-audit-");

function writeAuthoringArtifacts(benchmarkLayout: BenchmarkLayout, options: {
  taskExtract?: TaskExtractResult;
  packBaseUrl?: string;
} = {}): void {
  const artifacts = createPackAuthoringArtifacts(options);
  writeYaml(benchmarkLayout.suite_path, artifacts.suite);
  writeYaml(benchmarkVendorCardPath(benchmarkLayout, "acme"), artifacts.vendor);
  writeYaml(benchmarkSurfacesPath(benchmarkLayout, "acme"), artifacts.surfaces);
  writeYaml(benchmarkOraclesPath(benchmarkLayout, "acme"), artifacts.tasks);
  writeYaml(benchmarkCompiledPackPath(benchmarkLayout, "acme"), artifacts.pack);
}

describe("auditBenchmarkPack", () => {
  it("passes a complete benchmark-layout pack contract", () => {
    const benchmarkLayout = layout();
    writeAuthoringArtifacts(benchmarkLayout);
    expect(auditBenchmarkPack(benchmarkLayout, "acme", packAuthoringConfig)).toEqual({ status: "pass", findings: [] });
  });

  it("reports every required missing artifact in deterministic order", () => {
    const benchmarkLayout = layout();
    const result = auditBenchmarkPack(benchmarkLayout, "acme", packAuthoringConfig);
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => "artifact" in finding ? finding.artifact : finding.code)).toEqual([
      "suite",
      "vendor-card",
      "surface-extract",
      "task-extract",
      "composed-pack",
    ]);
  });

  it("returns pack-scoped drift findings", () => {
    const benchmarkLayout = layout();
    writeAuthoringArtifacts(benchmarkLayout, { packBaseUrl: "https://changed.example" });
    expect(auditBenchmarkPack(benchmarkLayout, "acme", packAuthoringConfig)).toMatchObject({
      status: "fail",
      findings: [{ scope: "pack", slug: "acme", code: "pack_config_drift" }],
    });
  });

  it("fails closed without exposing details when authoring artifacts disagree", () => {
    const benchmarkLayout = layout();
    writeAuthoringArtifacts(benchmarkLayout);
    writeYaml(benchmarkOraclesPath(benchmarkLayout, "acme"), { ...packAuthoringTasks, vendor: "Other" });
    expect(auditBenchmarkPack(benchmarkLayout, "acme", packAuthoringConfig)).toEqual({
      status: "fail",
      findings: [{
        scope: "benchmark",
        slug: "acme",
        severity: "error",
        code: "benchmark_pack_inputs_invalid",
        message: "Reviewed authoring inputs cannot be composed for acme",
      }],
    });
  });
});
