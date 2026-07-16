import type { CapabilityExtractResult } from "../../src/generate/capability-extract.js";
import type { SurfaceExtractResult } from "../../src/generate/surface-extract.js";
import type { VendorSelectionLedger } from "../../src/generate/vendor-selection.js";

export function createVendorSelectionLedger(): VendorSelectionLedger {
  return {
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
    entries: [{
      slug: "acme",
      vendor: "Acme",
      status: "core",
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
    }],
  };
}

export const vendorSelectionCapabilityExtract: CapabilityExtractResult = {
  vendor: "Acme",
  slug: "acme",
  category: "database",
  extracted_at: "2026-07-16T00:00:00.000Z",
  extraction_provenance: { source: "official-docs", extractor: "test" },
  capabilities: [{
    capability_name: "records",
    title: "Record operations",
    description: "Create records.",
    resource_kind: "record",
    operation_kind: "create",
    surfaces_documented: ["cli"],
    support_type: "native",
    evidence: [{ doc_url: "https://docs.acme.example/records", quote: "POST /v1/records creates a record." }],
  }],
};

export const vendorSelectionSurfaceExtract: SurfaceExtractResult = {
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
};
