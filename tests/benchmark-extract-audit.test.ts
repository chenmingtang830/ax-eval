import { describe, expect, it } from "vitest";
import { auditBenchmarkExtracts } from "../src/generate/benchmark-extract-audit.js";
import {
  benchmarkCapabilityInventoryPath,
  benchmarkSurfacesPath,
  type BenchmarkLayout,
} from "../src/generate/benchmark-paths.js";
import type { CapabilityExtractResult } from "../src/generate/capability-extract.js";
import type { SurfaceExtractResult } from "../src/generate/surface-extract.js";
import { useBenchmarkTestLayout } from "./fixtures/benchmark-layout.js";

const { layout, writeYaml } = useBenchmarkTestLayout("ax-benchmark-extract-audit-");

function capabilities(overrides: Partial<CapabilityExtractResult["capabilities"][number]> = {}): CapabilityExtractResult {
  return {
    vendor: "Acme",
    slug: "acme",
    category: "database",
    extracted_at: "2026-07-16T00:00:00.000Z",
    extraction_provenance: { source: "official-docs", extractor: "test" },
    capabilities: [{
      capability_name: "create-record",
      title: "Create records",
      family: "records",
      description: "Create one record.",
      resource_kind: "record",
      operation_kind: "create",
      surfaces_documented: ["api"],
      support_type: "native",
      evidence: [{ doc_url: "https://docs.acme.example/records", quote: "POST /v1/records creates a record." }],
      ...overrides,
    }],
  };
}

const surfaces: SurfaceExtractResult = {
  vendor: "Acme",
  slug: "acme",
  extracted_at: "2026-07-16T00:00:00.000Z",
  cli: null,
  sdk: null,
  mcp: null,
};

function writeExtracts(benchmarkLayout: BenchmarkLayout, capabilityExtract = capabilities()): void {
  writeYaml(benchmarkCapabilityInventoryPath(benchmarkLayout, "acme"), capabilityExtract);
  writeYaml(benchmarkSurfacesPath(benchmarkLayout, "acme"), surfaces);
}

describe("auditBenchmarkExtracts", () => {
  it("passes matching direct capability and surface extracts", () => {
    const benchmarkLayout = layout();
    writeExtracts(benchmarkLayout);
    expect(auditBenchmarkExtracts(benchmarkLayout, "acme")).toEqual({ status: "pass", findings: [] });
  });

  it("returns warn when only advisory findings exist", () => {
    const benchmarkLayout = layout();
    writeExtracts(benchmarkLayout, capabilities({
      capability_name: "backup-and-restore",
      title: "Backup and restore",
      support_type: "managed-surface",
      evidence: [{ doc_url: "https://docs.acme.example/backups", quote: "POST /v1/backups requests a managed backup." }],
    }));
    expect(auditBenchmarkExtracts(benchmarkLayout, "acme")).toMatchObject({
      status: "warn",
      findings: [{ slug: "acme", code: "support_mediated_backup", severity: "warn" }],
    });
  });

  it("returns fail for missing required extracts", () => {
    const benchmarkLayout = layout();
    expect(auditBenchmarkExtracts(benchmarkLayout, "acme")).toMatchObject({
      status: "fail",
      findings: [
        { slug: "acme", code: "capability_extract_missing", severity: "error" },
        { slug: "acme", code: "surface_extract_missing", severity: "error" },
      ],
    });
  });

  it("preserves vendor-scoped errors from loaded artifacts", () => {
    const benchmarkLayout = layout();
    writeExtracts(benchmarkLayout, capabilities({ surfaces_documented: ["sdk"] }));
    expect(auditBenchmarkExtracts(benchmarkLayout, "acme")).toMatchObject({
      status: "fail",
      findings: [{ slug: "acme", code: "capability_surface_unavailable", surface: "sdk" }],
    });
  });
});
