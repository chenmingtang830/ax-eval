import { describe, expect, it } from "vitest";
import { auditBenchmarkAuthoring } from "../src/generate/benchmark-authoring-audit.js";
import {
  benchmarkCapabilityInventoryPath,
  benchmarkCompiledPackPath,
  benchmarkOraclesPath,
  benchmarkSurfacesPath,
  benchmarkVendorCardPath,
  type BenchmarkLayout,
} from "../src/generate/benchmark-paths.js";
import { useBenchmarkTestLayout } from "./fixtures/benchmark-layout.js";
import { createBenchmarkAuthoringArtifacts } from "./fixtures/benchmark-authoring.js";

const { layout, writeYaml } = useBenchmarkTestLayout("ax-benchmark-authoring-audit-");

async function writeArtifacts(benchmarkLayout: BenchmarkLayout, options: {
  persistSuite?: boolean;
  packBaseUrl?: string;
} = {}) {
  const artifacts = await createBenchmarkAuthoringArtifacts();
  if (options.persistSuite !== false) writeYaml(benchmarkLayout.suite_path, artifacts.suite);
  writeYaml(benchmarkLayout.suite_concept_universe_path, artifacts.universe);
  writeYaml(benchmarkLayout.suite_coverage_selection_path, artifacts.selection);
  writeYaml(benchmarkLayout.suite_coverage_matrix_path, artifacts.matrix);
  writeYaml(benchmarkLayout.vendor_selection_ledger_path, artifacts.ledger);
  writeYaml(benchmarkCapabilityInventoryPath(benchmarkLayout, "acme"), artifacts.capabilities);
  writeYaml(benchmarkSurfacesPath(benchmarkLayout, "acme"), artifacts.surfaces);
  writeYaml(benchmarkVendorCardPath(benchmarkLayout, "acme"), artifacts.vendor);
  writeYaml(benchmarkOraclesPath(benchmarkLayout, "acme"), artifacts.tasks);
  writeYaml(benchmarkCompiledPackPath(benchmarkLayout, "acme"), {
    ...artifacts.pack,
    base_url: options.packBaseUrl ?? artifacts.pack.base_url,
  });
  return artifacts;
}

function audit(benchmarkLayout: BenchmarkLayout, config: unknown) {
  return auditBenchmarkAuthoring(benchmarkLayout, {
    resetVerified: new Set(["acme"]),
    packConfigs: new Map([["acme", config]]),
  });
}

describe("auditBenchmarkAuthoring", () => {
  it("passes a coherent reviewed authoring contract", async () => {
    const benchmarkLayout = layout();
    const artifacts = await writeArtifacts(benchmarkLayout);
    expect(audit(benchmarkLayout, artifacts.config)).toMatchObject({
      status: "pass",
      summary: { errors: 0, warnings: 0 },
      suite_authoring: { status: "pass" },
      cohort_authoring: { status: "pass" },
      packs: { status: "pass" },
    });
  });

  it("stops cohort-dependent pack auditing when the vendor context is unavailable", () => {
    const result = auditBenchmarkAuthoring(layout(), {
      resetVerified: new Set(),
      packConfigs: new Map(),
    });
    expect(result.status).toBe("fail");
    expect(result.summary).toEqual({ errors: 5, warnings: 0 });
    expect(result.cohort_authoring.vendor_selection.findings).toEqual([
      expect.objectContaining({ code: "vendor_selection_ledger_missing" }),
    ]);
    expect(result.packs).toEqual({ status: "skipped", summary: { errors: 0 }, packs: [] });
  });

  it("reports a missing suite once and skips otherwise complete pack sections", async () => {
    const benchmarkLayout = layout();
    const artifacts = await writeArtifacts(benchmarkLayout, { persistSuite: false });
    const result = audit(benchmarkLayout, artifacts.config);
    expect(result.summary).toEqual({ errors: 1, warnings: 0 });
    expect(result.suite_authoring.suite.findings).toEqual([
      expect.objectContaining({ artifact: "suite" }),
    ]);
    expect(result.packs).toEqual({
      status: "skipped",
      summary: { errors: 0 },
      packs: [{ slug: "acme", status: "skipped", findings: [] }],
    });
  });

  it("preserves pack drift in the top-level summary", async () => {
    const benchmarkLayout = layout();
    const artifacts = await writeArtifacts(benchmarkLayout, { packBaseUrl: "https://changed.example" });
    const result = audit(benchmarkLayout, artifacts.config);
    expect(result.status).toBe("fail");
    expect(result.summary).toEqual({ errors: 1, warnings: 0 });
    expect(result.packs.packs).toEqual([
      expect.objectContaining({ findings: [expect.objectContaining({ code: "pack_config_drift" })] }),
    ]);
  });

  it("preserves cohort warnings without turning skipped sections into failures", async () => {
    const benchmarkLayout = layout();
    const artifacts = await writeArtifacts(benchmarkLayout);
    writeYaml(benchmarkCapabilityInventoryPath(benchmarkLayout, "acme"), {
      ...artifacts.capabilities,
      capabilities: [{
        ...artifacts.capabilities.capabilities[0]!,
        capability_name: "backup-and-restore",
        title: "Backup and restore",
        support_type: "managed-surface",
      }],
    });
    const result = audit(benchmarkLayout, artifacts.config);
    expect(result.status).toBe("warn");
    expect(result.summary).toEqual({ errors: 0, warnings: 1 });
  });
});
