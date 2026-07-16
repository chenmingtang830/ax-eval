import {
  benchmarkCapabilityInventoryPath,
  benchmarkSurfacesPath,
  type BenchmarkLayout,
} from "./benchmark-paths.js";
import { loadCapabilityExtractPath, type CapabilityExtractResult } from "./capability-extract.js";
import { loadSurfaceExtractPath, type SurfaceExtractResult } from "./surface-extract.js";
import { loadVendorSelectionLedger, type VendorSelectionLedger } from "./vendor-selection.js";

export interface BenchmarkVendorContext {
  ledger: VendorSelectionLedger;
  core_slugs: string[];
  capabilities: ReadonlyMap<string, CapabilityExtractResult>;
  surfaces: ReadonlyMap<string, SurfaceExtractResult>;
}

export interface BenchmarkVendorContextFinding {
  scope: "benchmark";
  slug: null;
  severity: "error";
  code: "vendor_selection_ledger_missing" | "vendor_selection_benchmark_mismatch";
  message: string;
}

export type BenchmarkVendorContextResult =
  | { status: "ready"; context: BenchmarkVendorContext; findings: [] }
  | { status: "fail"; context: null; findings: [BenchmarkVendorContextFinding] };

export function loadBenchmarkVendorContext(layout: BenchmarkLayout): BenchmarkVendorContextResult {
  const ledger = loadVendorSelectionLedger(layout.vendor_selection_ledger_path);
  if (!ledger) {
    return {
      status: "fail",
      context: null,
      findings: [{
        scope: "benchmark",
        slug: null,
        severity: "error",
        code: "vendor_selection_ledger_missing",
        message: `Vendor selection ledger is missing at ${layout.vendor_selection_ledger_path}`,
      }],
    };
  }
  if (ledger.benchmark.slug !== layout.benchmark || ledger.benchmark.version !== layout.version) {
    return {
      status: "fail",
      context: null,
      findings: [{
        scope: "benchmark",
        slug: null,
        severity: "error",
        code: "vendor_selection_benchmark_mismatch",
        message: `Vendor selection ledger targets ${ledger.benchmark.slug}/${ledger.benchmark.version}, expected ${layout.benchmark}/${layout.version}`,
      }],
    };
  }

  const coreSlugs = ledger.entries.filter((entry) => entry.status === "core").map((entry) => entry.slug);
  const capabilities = new Map<string, CapabilityExtractResult>();
  const surfaces = new Map<string, SurfaceExtractResult>();
  for (const slug of coreSlugs) {
    const capabilityExtract = loadCapabilityExtractPath(benchmarkCapabilityInventoryPath(layout, slug));
    if (capabilityExtract) capabilities.set(slug, capabilityExtract);
    const surfaceExtract = loadSurfaceExtractPath(benchmarkSurfacesPath(layout, slug));
    if (surfaceExtract) surfaces.set(slug, surfaceExtract);
  }
  return {
    status: "ready",
    context: { ledger, core_slugs: coreSlugs, capabilities, surfaces },
    findings: [],
  };
}
