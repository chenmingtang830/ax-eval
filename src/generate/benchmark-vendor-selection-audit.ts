import type { BenchmarkLayout } from "./benchmark-paths.js";
import {
  loadBenchmarkVendorContext,
  type BenchmarkVendorContextFinding,
} from "./benchmark-vendor-context.js";
import {
  auditVendorSelectionEvidence,
  type VendorSelectionFinding,
} from "./vendor-selection-audit.js";

export type BenchmarkVendorSelectionFinding =
  | BenchmarkVendorContextFinding
  | (VendorSelectionFinding & { scope: "vendor" });

export interface BenchmarkVendorSelectionAuditResult {
  status: "pass" | "fail";
  findings: BenchmarkVendorSelectionFinding[];
}

export function auditBenchmarkVendorSelection(
  layout: BenchmarkLayout,
  resetVerified: ReadonlySet<string>,
): BenchmarkVendorSelectionAuditResult {
  const loaded = loadBenchmarkVendorContext(layout);
  if (loaded.status === "fail") return { status: "fail", findings: loaded.findings };
  const { ledger, capabilities, surfaces } = loaded.context;
  const findings = auditVendorSelectionEvidence(ledger, { capabilities, surfaces, resetVerified })
    .map((finding): BenchmarkVendorSelectionFinding => ({ ...finding, scope: "vendor" }));
  return { status: findings.length === 0 ? "pass" : "fail", findings };
}
