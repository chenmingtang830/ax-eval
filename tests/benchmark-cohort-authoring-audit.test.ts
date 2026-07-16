import { describe, expect, it } from "vitest";
import { auditBenchmarkCohortAuthoring } from "../src/generate/benchmark-cohort-authoring-audit.js";
import {
  benchmarkCapabilityInventoryPath,
  benchmarkSurfacesPath,
  type BenchmarkLayout,
} from "../src/generate/benchmark-paths.js";
import { useBenchmarkTestLayout } from "./fixtures/benchmark-layout.js";
import {
  createVendorSelectionLedger,
  vendorSelectionCapabilityExtract,
  vendorSelectionSurfaceExtract,
} from "./fixtures/vendor-selection.js";

const { layout, writeYaml } = useBenchmarkTestLayout("ax-benchmark-cohort-authoring-audit-");

function writeLedger(benchmarkLayout: BenchmarkLayout): void {
  writeYaml(benchmarkLayout.vendor_selection_ledger_path, createVendorSelectionLedger());
}

function writeCoreExtracts(benchmarkLayout: BenchmarkLayout): void {
  writeYaml(benchmarkCapabilityInventoryPath(benchmarkLayout, "acme"), vendorSelectionCapabilityExtract);
  writeYaml(benchmarkSurfacesPath(benchmarkLayout, "acme"), vendorSelectionSurfaceExtract);
}

describe("auditBenchmarkCohortAuthoring", () => {
  it("passes a fully evidenced core cohort", () => {
    const benchmarkLayout = layout();
    writeLedger(benchmarkLayout);
    writeCoreExtracts(benchmarkLayout);
    expect(auditBenchmarkCohortAuthoring(benchmarkLayout, new Set(["acme"]))).toEqual({
      status: "pass",
      summary: { errors: 0, warnings: 0 },
      vendor_selection: { status: "pass", findings: [] },
      extracts: [{ slug: "acme", status: "pass", findings: [] }],
    });
  });

  it("reports a missing ledger before cohort sections run", () => {
    expect(auditBenchmarkCohortAuthoring(layout(), new Set())).toMatchObject({
      status: "fail",
      summary: { errors: 1, warnings: 0 },
      vendor_selection: { findings: [{ code: "vendor_selection_ledger_missing" }] },
      extracts: [],
    });
  });

  it("reports missing core extracts once and marks their section skipped", () => {
    const benchmarkLayout = layout();
    writeLedger(benchmarkLayout);
    const result = auditBenchmarkCohortAuthoring(benchmarkLayout, new Set(["acme"]));
    expect(result.summary).toEqual({ errors: 2, warnings: 0 });
    expect(result.vendor_selection.findings).toEqual([
      expect.objectContaining({ slug: "acme", code: "core_capability_extract_missing" }),
      expect.objectContaining({ slug: "acme", code: "core_surface_extract_missing" }),
    ]);
    expect(result.extracts).toEqual([{ slug: "acme", status: "skipped", findings: [] }]);
  });

  it("reports core extract identity drift once", () => {
    const benchmarkLayout = layout();
    writeLedger(benchmarkLayout);
    writeYaml(benchmarkCapabilityInventoryPath(benchmarkLayout, "acme"), {
      ...vendorSelectionCapabilityExtract,
      slug: "other",
    });
    writeYaml(benchmarkSurfacesPath(benchmarkLayout, "acme"), vendorSelectionSurfaceExtract);
    const result = auditBenchmarkCohortAuthoring(benchmarkLayout, new Set(["acme"]));
    expect(result.summary).toEqual({ errors: 1, warnings: 0 });
    expect(result.vendor_selection.findings).toEqual([
      expect.objectContaining({ slug: "acme", code: "capability_extract_identity_mismatch" }),
    ]);
    expect(result.extracts).toEqual([{ slug: "acme", status: "skipped", findings: [] }]);
  });

  it("preserves extract warnings in the aggregate status", () => {
    const benchmarkLayout = layout();
    writeLedger(benchmarkLayout);
    writeYaml(benchmarkCapabilityInventoryPath(benchmarkLayout, "acme"), {
      ...vendorSelectionCapabilityExtract,
      capabilities: [{
        ...vendorSelectionCapabilityExtract.capabilities[0]!,
        capability_name: "backup-and-restore",
        title: "Backup and restore",
        support_type: "managed-surface",
      }],
    });
    writeYaml(benchmarkSurfacesPath(benchmarkLayout, "acme"), vendorSelectionSurfaceExtract);
    const result = auditBenchmarkCohortAuthoring(benchmarkLayout, new Set(["acme"]));
    expect(result.status).toBe("warn");
    expect(result.summary).toEqual({ errors: 0, warnings: 1 });
    expect(result.extracts).toEqual([{
      slug: "acme",
      status: "warn",
      findings: [expect.objectContaining({ code: "support_mediated_backup" })],
    }]);
  });
});
