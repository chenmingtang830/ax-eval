import { describe, expect, it } from "vitest";
import type { CapabilityExtractResult } from "../src/generate/capability-extract.js";
import { auditExtracts } from "../src/generate/extract-audit.js";
import type { SurfaceExtractResult } from "../src/generate/surface-extract.js";

function capability(
  overrides: Partial<CapabilityExtractResult["capabilities"][number]> = {},
): CapabilityExtractResult["capabilities"][number] {
  return {
    capability_name: "create-record",
    title: "Create records",
    family: "records",
    description: "Create one record.",
    resource_kind: "record",
    operation_kind: "create",
    surfaces_documented: ["api", "cli"],
    support_type: "native",
    evidence: [{ doc_url: "https://docs.acme.example/records", quote: "POST /v1/records creates a record." }],
    ...overrides,
  };
}

function capabilities(entries = [capability()]): CapabilityExtractResult {
  return {
    vendor: "Acme",
    slug: "acme",
    category: "database",
    extracted_at: "2026-07-16T00:00:00.000Z",
    extraction_provenance: { source: "official-docs", extractor: "test" },
    capabilities: entries,
  };
}

function surfaces(overrides: Partial<SurfaceExtractResult> = {}): SurfaceExtractResult {
  return {
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
    ...overrides,
  };
}

describe("auditExtracts", () => {
  it("accepts direct evidence with matching surface metadata", () => {
    expect(auditExtracts({ slug: "acme", capabilities: capabilities(), surfaces: surfaces() })).toEqual([]);
  });

  it("reports missing artifacts without inventing repair actions", () => {
    expect(auditExtracts({ slug: "acme", capabilities: null, surfaces: null }).map((finding) => finding.code)).toEqual([
      "capability_extract_missing",
      "surface_extract_missing",
    ]);
  });

  it("requires direct operation evidence and documented surfaces", () => {
    const weak = capability({
      capability_name: "weak",
      surfaces_documented: [],
      evidence: [{ doc_url: "https://docs.acme.example/overview", quote: "Acme supports flexible records." }],
    });
    expect(auditExtracts({ slug: "acme", capabilities: capabilities([weak]), surfaces: surfaces() })
      .map((finding) => finding.code)).toEqual([
      "capability_direct_evidence_missing",
      "capability_surfaces_missing",
    ]);
  });

  it("warns on summary evidence even when direct evidence exists", () => {
    const mixed = capability({
      evidence: [
        { doc_url: "https://docs.acme.example/records", quote: "POST /v1/records creates a record." },
        { doc_url: "https://docs.acme.example/llms.txt", quote: "API overview." },
      ],
    });
    expect(auditExtracts({ slug: "acme", capabilities: capabilities([mixed]), surfaces: surfaces() })
      .map((finding) => finding.code)).toEqual(["capability_summary_evidence"]);
  });

  it("rejects executable surface attribution without matching surface metadata", () => {
    const sdkCapability = capability({ surfaces_documented: ["sdk"] });
    expect(auditExtracts({ slug: "acme", capabilities: capabilities([sdkCapability]), surfaces: surfaces() }))
      .toEqual([expect.objectContaining({ code: "capability_surface_unavailable", surface: "sdk" })]);
  });

  it("flags GUI-only evidence and support-mediated backup workflows", () => {
    const gui = capability({
      capability_name: "edit-table",
      evidence: [{ doc_url: "https://docs.acme.example/console", quote: "Use the dashboard editor to modify the table." }],
    });
    const backup = capability({
      capability_name: "backup-and-restore",
      title: "Backup and restore",
      support_type: "managed-surface",
      evidence: [{ doc_url: "https://docs.acme.example/backups", quote: "Contact support to restore a snapshot." }],
    });
    expect(auditExtracts({ slug: "acme", capabilities: capabilities([gui, backup]), surfaces: surfaces() })
      .map((finding) => finding.code)).toEqual([
      "capability_direct_evidence_missing",
      "capability_gui_only_evidence",
      "capability_direct_evidence_missing",
      "support_mediated_backup",
    ]);
  });

  it("does not call evidence GUI-only when it documents a direct operation", () => {
    const mixed = capability({
      evidence: [{
        doc_url: "https://docs.acme.example/records",
        quote: "Use the web console or POST /v1/records to create a record.",
      }],
    });
    expect(auditExtracts({ slug: "acme", capabilities: capabilities([mixed]), surfaces: surfaces() })).toEqual([]);
  });

  it("does not treat OAuth-only surface metadata as proven headless access", () => {
    const oauth = surfaces({ cli: { ...surfaces().cli!, auth: { kind: "oauth_app" } } });
    expect(auditExtracts({ slug: "acme", capabilities: capabilities(), surfaces: oauth }))
      .toEqual([expect.objectContaining({ code: "oauth_headless_unproven", surface: "cli" })]);
  });

  it("reports identity drift and avoids cross-vendor surface conclusions", () => {
    const otherSurfaces = surfaces({ vendor: "Other" });
    expect(auditExtracts({ slug: "acme", capabilities: capabilities(), surfaces: otherSurfaces })
      .map((finding) => finding.code)).toEqual(["extract_identity_mismatch"]);
  });
});
