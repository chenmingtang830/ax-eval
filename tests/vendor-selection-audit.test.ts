import { describe, expect, it } from "vitest";
import type { CapabilityExtractResult } from "../src/generate/capability-extract.js";
import type { SurfaceExtractResult } from "../src/generate/surface-extract.js";
import { auditVendorSelectionEvidence } from "../src/generate/vendor-selection-audit.js";
import { VendorSelectionLedgerSchema, type VendorSelectionLedger } from "../src/generate/vendor-selection.js";

function ledger(status: "core" | "research" = "core"): VendorSelectionLedger {
  return VendorSelectionLedgerSchema.parse({
    schema: "ax.vendor-selection-ledger/v1",
    benchmark: { slug: "database-eval", version: "v1" },
    generated_at: "2026-07-16T00:00:00.000Z",
    methodology: {
      sampling: "purposive-stratified",
      population: "Managed database products with a persistent sandbox.",
      core_rule: "Core vendors satisfy every required eligibility claim.",
      research_rule: "Research vendors retain unresolved eligibility claims.",
      exclusion_rule: "Excluded vendors fail a required eligibility claim.",
      minimum_core_vendors: 1,
    },
    entries: status === "core" ? [{
      slug: "acme",
      vendor: "Acme",
      status,
      stratum: "database",
      rationale: "Core cohort rationale.",
      eligibility: {
        managed_service: true,
        persistent_free_sandbox: true,
        headless_auth: "yes",
        benchmark_surface: "yes",
        reset_feasibility: "yes",
      },
      sources: ["https://docs.acme.example/overview"],
    }] : [{
      slug: "core-placeholder",
      vendor: "Core Placeholder",
      status: "core",
      stratum: "database",
      rationale: "Required core placeholder.",
      eligibility: {
        managed_service: true,
        persistent_free_sandbox: true,
        headless_auth: "yes",
        benchmark_surface: "yes",
        reset_feasibility: "yes",
      },
      sources: ["https://docs.placeholder.example/overview"],
    }, {
      slug: "acme",
      vendor: "Acme",
      status,
      stratum: "database",
      rationale: "Research cohort rationale.",
      eligibility: {
        managed_service: true,
        persistent_free_sandbox: true,
        headless_auth: "unknown",
        benchmark_surface: "unknown",
        reset_feasibility: "unknown",
      },
      sources: ["https://docs.acme.example/overview"],
    }],
  });
}

function capabilities(surfaces: Array<"api" | "cli" | "sdk" | "mcp"> = ["cli"]): CapabilityExtractResult {
  return {
    vendor: "Acme",
    slug: "acme",
    category: "database",
    extracted_at: "2026-07-16T00:00:00.000Z",
    extraction_provenance: { source: "official-docs", extractor: "test" },
    capabilities: [{
      capability_name: "records",
      title: "Record operations",
      family: "data",
      description: "Create records.",
      resource_kind: "record",
      operation_kind: "create",
      surfaces_documented: surfaces,
      support_type: "native",
      evidence: [{ doc_url: "https://docs.acme.example/records", quote: "Create records." }],
    }],
  };
}

function surfaceExtract(kind: "inherit" | "token" | "oauth_app" = "inherit"): SurfaceExtractResult {
  return {
    vendor: "Acme",
    slug: "acme",
    extracted_at: "2026-07-16T00:00:00.000Z",
    cli: {
      bin: "acme",
      install: "npm install -g acme-cli",
      docs_url: "https://docs.acme.example/cli",
      auth: kind === "token" ? { kind, token_env: "ACME_TOKEN" } : { kind },
    },
    sdk: null,
    mcp: null,
  };
}

describe("auditVendorSelectionEvidence", () => {
  it("accepts matching capability and headless surface evidence", () => {
    expect(auditVendorSelectionEvidence(ledger(), {
      capabilities: new Map([["acme", capabilities()]]),
      surfaces: new Map([["acme", surfaceExtract()]]),
      resetVerified: new Set(["acme"]),
    })).toEqual([]);
  });

  it("reports missing core artifacts without cascading claim findings", () => {
    expect(auditVendorSelectionEvidence(ledger(), {
      capabilities: new Map(),
      surfaces: new Map(),
      resetVerified: new Set(["acme"]),
    }).map((finding) => finding.code)).toEqual([
      "core_capability_extract_missing",
      "core_surface_extract_missing",
    ]);
  });

  it("rejects artifacts belonging to another vendor", () => {
    const wrongCapabilities = { ...capabilities(), slug: "other" };
    const wrongSurfaces = { ...surfaceExtract(), vendor: "Other" };
    expect(auditVendorSelectionEvidence(ledger(), {
      capabilities: new Map([["acme", wrongCapabilities]]),
      surfaces: new Map([["acme", wrongSurfaces]]),
      resetVerified: new Set(["acme"]),
    }).map((finding) => finding.code)).toEqual([
      "capability_extract_identity_mismatch",
      "surface_extract_identity_mismatch",
    ]);
  });

  it("requires capability documentation and surface metadata to overlap", () => {
    expect(auditVendorSelectionEvidence(ledger(), {
      capabilities: new Map([["acme", capabilities(["sdk"])]]),
      surfaces: new Map([["acme", surfaceExtract()]]),
      resetVerified: new Set(["acme"]),
    }).map((finding) => finding.code)).toEqual([
      "core_benchmark_surface_unproven",
      "core_headless_auth_unproven",
    ]);
  });

  it("does not treat OAuth-only access as proven headless auth", () => {
    expect(auditVendorSelectionEvidence(ledger(), {
      capabilities: new Map([["acme", capabilities()]]),
      surfaces: new Map([["acme", surfaceExtract("oauth_app")]]),
      resetVerified: new Set(["acme"]),
    }).map((finding) => finding.code)).toEqual(["core_headless_auth_unproven"]);
  });

  it("requires independent reset verification for core vendors", () => {
    expect(auditVendorSelectionEvidence(ledger(), {
      capabilities: new Map([["acme", capabilities()]]),
      surfaces: new Map([["acme", surfaceExtract()]]),
      resetVerified: new Set(),
    }).map((finding) => finding.code)).toEqual(["core_reset_feasibility_unproven"]);
  });

  it("does not require authoring artifacts for research vendors", () => {
    const researchLedger = ledger("research");
    const core = researchLedger.entries[0]!;
    expect(auditVendorSelectionEvidence(researchLedger, {
      capabilities: new Map([[core.slug, { ...capabilities(), slug: core.slug, vendor: core.vendor }]]),
      surfaces: new Map([[core.slug, { ...surfaceExtract(), slug: core.slug, vendor: core.vendor }]]),
      resetVerified: new Set([core.slug]),
    })).toEqual([]);
  });
});
