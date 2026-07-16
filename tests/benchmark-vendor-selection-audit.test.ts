import { describe, expect, it } from "vitest";
import { auditBenchmarkVendorSelection } from "../src/generate/benchmark-vendor-selection-audit.js";
import {
  benchmarkCapabilityInventoryPath,
  benchmarkSurfacesPath,
  type BenchmarkLayout,
} from "../src/generate/benchmark-paths.js";
import type { VendorSelectionLedger } from "../src/generate/vendor-selection.js";
import { useBenchmarkTestLayout } from "./fixtures/benchmark-layout.js";
import {
  createVendorSelectionLedger,
  vendorSelectionCapabilityExtract,
  vendorSelectionSurfaceExtract,
} from "./fixtures/vendor-selection.js";

const { layout, writeYaml } = useBenchmarkTestLayout("ax-benchmark-selection-");

function writeLedger(benchmarkLayout: BenchmarkLayout, value: VendorSelectionLedger = createVendorSelectionLedger()): void {
  writeYaml(benchmarkLayout.vendor_selection_ledger_path, value);
}

describe("auditBenchmarkVendorSelection", () => {
  it("loads benchmark artifacts and passes a fully evidenced core cohort", () => {
    const benchmarkLayout = layout();
    writeLedger(benchmarkLayout);
    writeYaml(benchmarkCapabilityInventoryPath(benchmarkLayout, "acme"), vendorSelectionCapabilityExtract);
    writeYaml(benchmarkSurfacesPath(benchmarkLayout, "acme"), vendorSelectionSurfaceExtract);

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
    writeLedger(benchmarkLayout, { ...createVendorSelectionLedger(), benchmark: { slug: "other-eval", version: "v2" } });
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
