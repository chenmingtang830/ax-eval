import { describe, expect, it } from "vitest";
import { auditBenchmarkVendorSelection } from "../src/generate/benchmark-vendor-selection-audit.js";
import {
  benchmarkCapabilityInventoryPath,
  benchmarkSurfacesPath,
  type BenchmarkLayout,
} from "../src/generate/benchmark-paths.js";
import type { CapabilityExtractResult } from "../src/generate/capability-extract.js";
import type { SurfaceExtractResult } from "../src/generate/surface-extract.js";
import type { VendorSelectionLedger } from "../src/generate/vendor-selection.js";
import { useBenchmarkTestLayout } from "./fixtures/benchmark-layout.js";

const { layout, writeYaml } = useBenchmarkTestLayout("ax-benchmark-selection-");

function ledger(): VendorSelectionLedger {
  return {
    schema: "ax.vendor-selection-ledger/v1",
    benchmark: { slug: "database-eval", version: "v1" },
    generated_at: "2026-07-16T00:00:00.000Z",
    methodology: {
      sampling: "purposive-stratified",
      population: "Managed database products with a persistent sandbox.",
      core_rule: "Core vendors satisfy every required eligibility claim.",
      research_rule: "Research vendors retain unresolved eligibility claims.",
      exclusion_rule: "Excluded vendors fail a required eligibility claim.",
      minimum_core_vendors: 1,
    },
    entries: [{
      slug: "acme",
      vendor: "Acme",
      status: "core",
      stratum: "database",
      rationale: "Core cohort rationale.",
      eligibility: {
        managed_service: true,
        persistent_free_sandbox: true,
        headless_auth: "yes",
        benchmark_surface: "yes",
        reset_feasibility: "yes",
      },
      sources: ["https://docs.acme.example/overview"],
    }],
  };
}

const capabilityExtract: CapabilityExtractResult = {
  vendor: "Acme",
  slug: "acme",
  category: "database",
  extracted_at: "2026-07-16T00:00:00.000Z",
  extraction_provenance: { source: "official-docs", extractor: "test" },
  capabilities: [{
    capability_name: "records",
    title: "Record operations",
    family: "data",
    description: "Create records.",
    resource_kind: "record",
    operation_kind: "create",
    surfaces_documented: ["cli"],
    support_type: "native",
    evidence: [{ doc_url: "https://docs.acme.example/records", quote: "Create records." }],
  }],
};

const surfaceExtract: SurfaceExtractResult = {
  vendor: "Acme",
  slug: "acme",
  extracted_at: "2026-07-16T00:00:00.000Z",
  cli: {
    bin: "acme",
    install: "npm install -g acme-cli",
    docs_url: "https://docs.acme.example/cli",
    auth: { kind: "inherit" },
  },
  sdk: null,
  mcp: null,
};

function writeLedger(benchmarkLayout: BenchmarkLayout, value: VendorSelectionLedger = ledger()): void {
  writeYaml(benchmarkLayout.vendor_selection_ledger_path, value);
}

describe("auditBenchmarkVendorSelection", () => {
  it("loads benchmark artifacts and passes a fully evidenced core cohort", () => {
    const benchmarkLayout = layout();
    writeLedger(benchmarkLayout);
    writeYaml(benchmarkCapabilityInventoryPath(benchmarkLayout, "acme"), capabilityExtract);
    writeYaml(benchmarkSurfacesPath(benchmarkLayout, "acme"), surfaceExtract);

    expect(auditBenchmarkVendorSelection(benchmarkLayout, new Set(["acme"]))).toEqual({
      status: "pass",
      findings: [],
    });
  });

  it("reports a missing ledger as an explicit benchmark failure", () => {
    const benchmarkLayout = layout();
    expect(auditBenchmarkVendorSelection(benchmarkLayout, new Set())).toMatchObject({
      status: "fail",
      findings: [{ scope: "benchmark", code: "vendor_selection_ledger_missing", slug: null }],
    });
  });

  it("stops when ledger benchmark identity does not match the layout", () => {
    const benchmarkLayout = layout();
    writeLedger(benchmarkLayout, { ...ledger(), benchmark: { slug: "other-eval", version: "v2" } });
    expect(auditBenchmarkVendorSelection(benchmarkLayout, new Set())).toMatchObject({
      status: "fail",
      findings: [{ scope: "benchmark", code: "vendor_selection_benchmark_mismatch", slug: null }],
    });
  });

  it("reports missing core extracts through vendor-scoped findings", () => {
    const benchmarkLayout = layout();
    writeLedger(benchmarkLayout);
    expect(auditBenchmarkVendorSelection(benchmarkLayout, new Set(["acme"]))).toMatchObject({
      status: "fail",
      findings: [
        { scope: "vendor", slug: "acme", code: "core_capability_extract_missing" },
        { scope: "vendor", slug: "acme", code: "core_surface_extract_missing" },
      ],
    });
  });

  it("fails closed when an extract at the expected path is malformed", () => {
    const benchmarkLayout = layout();
    writeLedger(benchmarkLayout);
    writeYaml(benchmarkCapabilityInventoryPath(benchmarkLayout, "acme"), { vendor: "Acme" });
    expect(() => auditBenchmarkVendorSelection(benchmarkLayout, new Set(["acme"])))
      .toThrow(`Invalid capability extract at ${benchmarkCapabilityInventoryPath(benchmarkLayout, "acme")}`);
  });
});
