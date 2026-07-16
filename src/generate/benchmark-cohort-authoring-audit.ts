import {
  loadBenchmarkVendorContext,
  type BenchmarkVendorContext,
  type BenchmarkVendorContextFinding,
  type BenchmarkVendorContextResult,
} from "./benchmark-vendor-context.js";
import {
  auditBenchmarkVendorSelectionContext,
  type BenchmarkVendorSelectionAuditResult,
  type BenchmarkVendorSelectionFinding,
} from "./benchmark-vendor-selection-audit.js";
import type { BenchmarkLayout } from "./benchmark-paths.js";
import { auditExtracts, type ExtractAuditFinding } from "./extract-audit.js";

export interface BenchmarkCohortExtractFinding extends ExtractAuditFinding {
  slug: string;
}

export interface BenchmarkCohortExtractAuditResult {
  slug: string;
  status: "pass" | "warn" | "fail" | "skipped";
  findings: BenchmarkCohortExtractFinding[];
}

export interface BenchmarkCohortAuthoringAuditResult {
  status: "pass" | "warn" | "fail";
  summary: {
    errors: number;
    warnings: number;
  };
  vendor_selection: BenchmarkVendorSelectionAuditResult;
  extracts: BenchmarkCohortExtractAuditResult[];
}

function vendorSelectionOwnsExtractFinding(
  finding: BenchmarkCohortExtractFinding,
  selectionFindings: readonly BenchmarkVendorSelectionFinding[],
): boolean {
  const selectionCode = finding.code === "capability_extract_missing"
    ? "core_capability_extract_missing"
    : finding.code === "surface_extract_missing"
      ? "core_surface_extract_missing"
      : finding.code === "extract_identity_mismatch" && finding.artifact === "capability-extract"
        ? "capability_extract_identity_mismatch"
        : finding.code === "extract_identity_mismatch" && finding.artifact === "surface-extract"
          ? "surface_extract_identity_mismatch"
      : null;
  return selectionCode !== null && selectionFindings.some((selectionFinding) =>
    selectionFinding.scope === "vendor"
      && selectionFinding.slug === finding.slug
      && selectionFinding.code === selectionCode);
}

function failedContextResult(finding: BenchmarkVendorContextFinding): BenchmarkCohortAuthoringAuditResult {
  return {
    status: "fail",
    summary: { errors: 1, warnings: 0 },
    vendor_selection: { status: "fail", findings: [finding] },
    extracts: [],
  };
}

export function auditBenchmarkCohortAuthoringContext(
  context: BenchmarkVendorContext,
  resetVerified: ReadonlySet<string>,
): BenchmarkCohortAuthoringAuditResult {
  const vendorSelection = auditBenchmarkVendorSelectionContext(context, resetVerified);
  const extracts = context.core_slugs.map((slug): BenchmarkCohortExtractAuditResult => {
    const rawFindings = auditExtracts({
      slug,
      capabilities: context.capabilities.get(slug) ?? null,
      surfaces: context.surfaces.get(slug) ?? null,
    }).map((finding): BenchmarkCohortExtractFinding => ({ ...finding, slug }));
    const findings = rawFindings.filter((finding) =>
      !vendorSelectionOwnsExtractFinding(finding, vendorSelection.findings));
    const suppressedFindings = rawFindings.length - findings.length;
    const status = findings.some((finding) => finding.severity === "error")
      ? "fail"
      : findings.length > 0
        ? "warn"
        : suppressedFindings > 0
          ? "skipped"
          : "pass";
    return { slug, status, findings };
  });
  const findings = [
    ...vendorSelection.findings,
    ...extracts.flatMap((result) => result.findings),
  ];
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warn").length;
  return {
    status: errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
    summary: { errors, warnings },
    vendor_selection: vendorSelection,
    extracts,
  };
}

export function auditLoadedBenchmarkCohortAuthoring(
  loaded: BenchmarkVendorContextResult,
  resetVerified: ReadonlySet<string>,
): BenchmarkCohortAuthoringAuditResult {
  return loaded.status === "fail"
    ? failedContextResult(loaded.findings[0])
    : auditBenchmarkCohortAuthoringContext(loaded.context, resetVerified);
}

export function auditBenchmarkCohortAuthoring(
  layout: BenchmarkLayout,
  resetVerified: ReadonlySet<string>,
): BenchmarkCohortAuthoringAuditResult {
  return auditLoadedBenchmarkCohortAuthoring(loadBenchmarkVendorContext(layout), resetVerified);
}
