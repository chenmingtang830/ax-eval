import {
  benchmarkCapabilityInventoryPath,
  benchmarkSurfacesPath,
  type BenchmarkLayout,
} from "./benchmark-paths.js";
import { loadCapabilityExtractPath } from "./capability-extract.js";
import { auditExtracts, type ExtractAuditFinding } from "./extract-audit.js";
import { loadSurfaceExtractPath } from "./surface-extract.js";

export interface BenchmarkExtractAuditFinding extends ExtractAuditFinding {
  slug: string;
}

export interface BenchmarkExtractAuditResult {
  status: "pass" | "warn" | "fail";
  findings: BenchmarkExtractAuditFinding[];
}

export function auditBenchmarkExtracts(
  layout: BenchmarkLayout,
  slug: string,
): BenchmarkExtractAuditResult {
  const capabilities = loadCapabilityExtractPath(benchmarkCapabilityInventoryPath(layout, slug));
  const surfaces = loadSurfaceExtractPath(benchmarkSurfacesPath(layout, slug));
  const findings = auditExtracts({ slug, capabilities, surfaces })
    .map((finding) => ({ ...finding, slug }));
  const status = findings.some((finding) => finding.severity === "error")
    ? "fail"
    : findings.length > 0
      ? "warn"
      : "pass";
  return { status, findings };
}
