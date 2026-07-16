import { describe, expect, it } from "vitest";
import { auditBenchmarkCorePacks } from "../src/generate/benchmark-core-pack-audit.js";
import {
  benchmarkCapabilityInventoryPath,
  benchmarkCompiledPackPath,
  benchmarkOraclesPath,
  benchmarkSurfacesPath,
  benchmarkVendorCardPath,
  type BenchmarkLayout,
} from "../src/generate/benchmark-paths.js";
import { loadBenchmarkVendorContext } from "../src/generate/benchmark-vendor-context.js";
import { useBenchmarkTestLayout } from "./fixtures/benchmark-layout.js";
import {
  createPackAuthoringArtifacts,
  packAuthoringConfig,
} from "./fixtures/pack-authoring.js";
import {
  createVendorSelectionLedger,
  vendorSelectionCapabilityExtract,
} from "./fixtures/vendor-selection.js";

const { layout, writeYaml } = useBenchmarkTestLayout("ax-benchmark-core-pack-audit-");

function writeLedger(benchmarkLayout: BenchmarkLayout): void {
  writeYaml(benchmarkLayout.vendor_selection_ledger_path, createVendorSelectionLedger());
  writeYaml(benchmarkCapabilityInventoryPath(benchmarkLayout, "acme"), vendorSelectionCapabilityExtract);
}

function writePackArtifacts(benchmarkLayout: BenchmarkLayout, options: {
  persistSurface?: boolean;
  packBaseUrl?: string;
} = {}): void {
  const artifacts = createPackAuthoringArtifacts({ packBaseUrl: options.packBaseUrl });
  writeYaml(benchmarkLayout.suite_path, artifacts.suite);
  writeYaml(benchmarkVendorCardPath(benchmarkLayout, "acme"), artifacts.vendor);
  if (options.persistSurface !== false) {
    writeYaml(benchmarkSurfacesPath(benchmarkLayout, "acme"), artifacts.surfaces);
  }
  writeYaml(benchmarkOraclesPath(benchmarkLayout, "acme"), artifacts.tasks);
  writeYaml(benchmarkCompiledPackPath(benchmarkLayout, "acme"), artifacts.pack);
}

function context(benchmarkLayout: BenchmarkLayout) {
  const result = loadBenchmarkVendorContext(benchmarkLayout);
  if (result.status !== "ready") throw new Error("expected ready vendor context");
  return result.context;
}

describe("auditBenchmarkCorePacks", () => {
  it("passes every core pack with an explicit valid config", () => {
    const benchmarkLayout = layout();
    writeLedger(benchmarkLayout);
    writePackArtifacts(benchmarkLayout);
    expect(auditBenchmarkCorePacks(
      benchmarkLayout,
      context(benchmarkLayout),
      new Map([["acme", packAuthoringConfig]]),
    )).toEqual({
      status: "pass",
      summary: { errors: 0 },
      packs: [{ slug: "acme", status: "pass", findings: [] }],
    });
  });

  it("fails when a core vendor has no explicit compose config", () => {
    const benchmarkLayout = layout();
    writeLedger(benchmarkLayout);
    const result = auditBenchmarkCorePacks(benchmarkLayout, context(benchmarkLayout), new Map());
    expect(result).toMatchObject({
      status: "fail",
      summary: { errors: 1 },
      packs: [{ slug: "acme", findings: [{ code: "benchmark_pack_config_missing" }] }],
    });
  });

  it("fails invalid configs without exposing parser details", () => {
    const benchmarkLayout = layout();
    writeLedger(benchmarkLayout);
    const result = auditBenchmarkCorePacks(
      benchmarkLayout,
      context(benchmarkLayout),
      new Map([["acme", { base_url: "https://api.acme.example" }]]),
    );
    expect(result.packs[0]).toEqual({
      slug: "acme",
      status: "fail",
      findings: [{
        scope: "benchmark",
        slug: "acme",
        severity: "error",
        code: "benchmark_pack_config_invalid",
        message: "Core vendor acme has an invalid pack compose configuration",
      }],
    });
  });

  it("preserves pack drift findings", () => {
    const benchmarkLayout = layout();
    writeLedger(benchmarkLayout);
    writePackArtifacts(benchmarkLayout, { packBaseUrl: "https://changed.example" });
    const result = auditBenchmarkCorePacks(
      benchmarkLayout,
      context(benchmarkLayout),
      new Map([["acme", packAuthoringConfig]]),
    );
    expect(result).toMatchObject({
      status: "fail",
      packs: [{ slug: "acme", findings: [{ scope: "pack", code: "pack_config_drift" }] }],
    });
  });

  it("skips a pack whose only missing artifact is owned by upstream cohort audit", () => {
    const benchmarkLayout = layout();
    writeLedger(benchmarkLayout);
    const vendorContext = context(benchmarkLayout);
    writePackArtifacts(benchmarkLayout, { persistSurface: false });
    expect(auditBenchmarkCorePacks(
      benchmarkLayout,
      vendorContext,
      new Map([["acme", packAuthoringConfig]]),
    )).toEqual({
      status: "skipped",
      summary: { errors: 0 },
      packs: [{ slug: "acme", status: "skipped", findings: [] }],
    });
  });
});
