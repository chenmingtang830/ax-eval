import {
  benchmarkCapabilityInventoryPath,
  benchmarkSurfacesPath,
  type BenchmarkLayout,
} from "./benchmark-paths.js";
import { loadCapabilityExtractPath, type CapabilityExtractResult } from "./capability-extract.js";
import { loadSurfaceExtractPath, type SurfaceExtractResult } from "./surface-extract.js";
import {
  auditVendorSelectionEvidence,
  type VendorSelectionFinding,
} from "./vendor-selection-audit.js";
import { loadVendorSelectionLedger } from "./vendor-selection.js";

export type BenchmarkVendorSelectionFinding =
  | {
      scope: "benchmark";
      slug: null;
      severity: "error";
      code: "vendor_selection_ledger_missing" | "vendor_selection_benchmark_mismatch";
      message: string;
    }
  | (VendorSelectionFinding & { scope: "vendor" });

export interface BenchmarkVendorSelectionAuditResult {
  status: "pass" | "fail";
  findings: BenchmarkVendorSelectionFinding[];
}

export function auditBenchmarkVendorSelection(
  layout: BenchmarkLayout,
  resetVerified: ReadonlySet<string>,
): BenchmarkVendorSelectionAuditResult {
  const ledger = loadVendorSelectionLedger(layout.vendor_selection_ledger_path);
  if (!ledger) {
    return {
      status: "fail",
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
      findings: [{
        scope: "benchmark",
        slug: null,
        severity: "error",
        code: "vendor_selection_benchmark_mismatch",
        message: `Vendor selection ledger targets ${ledger.benchmark.slug}/${ledger.benchmark.version}, expected ${layout.benchmark}/${layout.version}`,
      }],
    };
  }

  const capabilities = new Map<string, CapabilityExtractResult>();
  const surfaces = new Map<string, SurfaceExtractResult>();
  for (const entry of ledger.entries) {
    if (entry.status !== "core") continue;
    const capabilityExtract = loadCapabilityExtractPath(benchmarkCapabilityInventoryPath(layout, entry.slug));
    if (capabilityExtract) capabilities.set(entry.slug, capabilityExtract);
    const surfaceExtract = loadSurfaceExtractPath(benchmarkSurfacesPath(layout, entry.slug));
    if (surfaceExtract) surfaces.set(entry.slug, surfaceExtract);
  }
  const findings = auditVendorSelectionEvidence(ledger, { capabilities, surfaces, resetVerified })
    .map((finding): BenchmarkVendorSelectionFinding => ({ ...finding, scope: "vendor" }));
  return { status: findings.length === 0 ? "pass" : "fail", findings };
}
