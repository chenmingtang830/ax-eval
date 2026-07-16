import { describe, expect, it } from "vitest";
import {
  benchmarkCapabilityInventoryPath,
  benchmarkSurfacesPath,
} from "../src/generate/benchmark-paths.js";
import { loadBenchmarkVendorContext } from "../src/generate/benchmark-vendor-context.js";
import { useBenchmarkTestLayout } from "./fixtures/benchmark-layout.js";
import {
  createVendorSelectionLedger,
  vendorSelectionCapabilityExtract,
  vendorSelectionSurfaceExtract,
} from "./fixtures/vendor-selection.js";

const { layout, writeYaml } = useBenchmarkTestLayout("ax-benchmark-vendor-context-");

describe("loadBenchmarkVendorContext", () => {
  it("loads the authoritative ordered core cohort and present extracts", () => {
    const benchmarkLayout = layout();
    writeYaml(benchmarkLayout.vendor_selection_ledger_path, createVendorSelectionLedger());
    writeYaml(benchmarkCapabilityInventoryPath(benchmarkLayout, "acme"), vendorSelectionCapabilityExtract);
    writeYaml(benchmarkSurfacesPath(benchmarkLayout, "acme"), vendorSelectionSurfaceExtract);

    const result = loadBenchmarkVendorContext(benchmarkLayout);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready vendor context");
    expect(result.context.core_slugs).toEqual(["acme"]);
    expect(result.context.capabilities.get("acme")).toEqual(vendorSelectionCapabilityExtract);
    expect(result.context.surfaces.get("acme")).toEqual(vendorSelectionSurfaceExtract);
  });

  it("keeps missing core extracts absent for downstream fail-closed audits", () => {
    const benchmarkLayout = layout();
    writeYaml(benchmarkLayout.vendor_selection_ledger_path, createVendorSelectionLedger());
    const result = loadBenchmarkVendorContext(benchmarkLayout);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready vendor context");
    expect(result.context.core_slugs).toEqual(["acme"]);
    expect(result.context.capabilities.size).toBe(0);
    expect(result.context.surfaces.size).toBe(0);
  });

  it("does not load research or excluded vendor extracts into the core context", () => {
    const benchmarkLayout = layout();
    const base = createVendorSelectionLedger();
    writeYaml(benchmarkLayout.vendor_selection_ledger_path, {
      ...base,
      entries: [
        ...base.entries,
        {
          ...base.entries[0]!,
          slug: "research-vendor",
          vendor: "Research Vendor",
          status: "research",
          eligibility: { ...base.entries[0]!.eligibility, headless_auth: "unknown" },
        },
        {
          ...base.entries[0]!,
          slug: "excluded-vendor",
          vendor: "Excluded Vendor",
          status: "excluded",
          exclusion_reason: "No persistent sandbox.",
          eligibility: { ...base.entries[0]!.eligibility, persistent_free_sandbox: false },
        },
      ],
    });
    writeYaml(benchmarkCapabilityInventoryPath(benchmarkLayout, "research-vendor"), { vendor: "invalid" });
    writeYaml(benchmarkSurfacesPath(benchmarkLayout, "excluded-vendor"), { vendor: "invalid" });

    const result = loadBenchmarkVendorContext(benchmarkLayout);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready vendor context");
    expect(result.context.core_slugs).toEqual(["acme"]);
    expect(result.context.capabilities.size).toBe(0);
    expect(result.context.surfaces.size).toBe(0);
  });

  it("fails before loading cohort artifacts when the ledger is missing", () => {
    const result = loadBenchmarkVendorContext(layout());
    expect(result).toMatchObject({
      status: "fail",
      context: null,
      findings: [{ code: "vendor_selection_ledger_missing" }],
    });
  });

  it("fails before loading cohort artifacts when benchmark identity differs", () => {
    const benchmarkLayout = layout();
    writeYaml(benchmarkLayout.vendor_selection_ledger_path, {
      ...createVendorSelectionLedger(),
      benchmark: { slug: "other-eval", version: "v2" },
    });
    expect(loadBenchmarkVendorContext(benchmarkLayout)).toMatchObject({
      status: "fail",
      context: null,
      findings: [{ code: "vendor_selection_benchmark_mismatch" }],
    });
  });
});
