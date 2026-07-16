import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadVendorSelectionLedger,
  VendorSelectionLedgerSchema,
  vendorSlugsByStatus,
} from "../src/generate/vendor-selection.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function entry(slug: string, status: "core" | "research" | "excluded" = "core") {
  return {
    slug,
    vendor: slug.toUpperCase(),
    status,
    stratum: "database",
    rationale: `${status} cohort rationale`,
    eligibility: {
      managed_service: true,
      persistent_free_sandbox: true,
      headless_auth: "yes" as const,
      benchmark_surface: "yes" as const,
      reset_feasibility: "yes" as const,
    },
    ...(status === "excluded" ? { exclusion_reason: "Does not meet the cohort policy." } : {}),
    sources: [`https://${slug}.example.com/docs`],
  };
}

function ledger() {
  return {
    schema: "ax.vendor-selection-ledger/v1" as const,
    benchmark: { slug: "database-eval", version: "v1" },
    generated_at: "2026-07-16T00:00:00.000Z",
    methodology: {
      sampling: "purposive-stratified" as const,
      population: "Managed database products with a persistent sandbox.",
      core_rule: "Core vendors satisfy every required eligibility claim.",
      research_rule: "Research vendors retain unresolved eligibility claims.",
      exclusion_rule: "Excluded vendors fail a required eligibility claim.",
      minimum_core_vendors: 2,
    },
    entries: [entry("alpha"), entry("beta"), entry("gamma", "research"), entry("delta", "excluded")],
  };
}

describe("VendorSelectionLedgerSchema", () => {
  it("accepts an explicit reviewed cohort and preserves ledger order", () => {
    const parsed = VendorSelectionLedgerSchema.parse(ledger());
    expect(vendorSlugsByStatus(parsed, "core")).toEqual(["alpha", "beta"]);
    expect(vendorSlugsByStatus(parsed, "research")).toEqual(["gamma"]);
    expect(vendorSlugsByStatus(parsed, "excluded")).toEqual(["delta"]);
  });

  it("requires confirmed reset feasibility for core vendors", () => {
    const input = ledger();
    input.entries[0]!.eligibility.reset_feasibility = "unknown";
    expect(VendorSelectionLedgerSchema.safeParse(input).error?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["entries", 0, "eligibility", "reset_feasibility"] }),
    ]));
  });

  it("rejects duplicate slugs and insufficient core coverage", () => {
    const input = ledger();
    input.entries[1]!.slug = "alpha";
    input.entries[1]!.status = "research";
    input.entries[2]!.status = "excluded";
    input.entries[2]!.exclusion_reason = "Not eligible.";
    expect(VendorSelectionLedgerSchema.safeParse(input).error?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "vendor selection slugs must be unique" }),
      expect.objectContaining({ message: "vendor ledger requires at least 2 core vendors" }),
    ]));
  });

  it("requires exclusion reasons only for excluded vendors", () => {
    const excluded = ledger();
    delete excluded.entries[3]!.exclusion_reason;
    expect(VendorSelectionLedgerSchema.safeParse(excluded).success).toBe(false);

    const core = ledger();
    core.entries[0]!.exclusion_reason = "Contradictory reason.";
    expect(VendorSelectionLedgerSchema.safeParse(core).success).toBe(false);
  });

  it("rejects unsafe source URLs and path segments", () => {
    const input = ledger();
    input.entries[0]!.sources = ["http://localhost/docs"];
    input.entries[1]!.slug = "../beta";
    expect(VendorSelectionLedgerSchema.safeParse(input).success).toBe(false);
  });
});

describe("loadVendorSelectionLedger", () => {
  it("returns null for a missing file and validates loaded YAML", () => {
    const directory = mkdtempSync(join(tmpdir(), "ax-vendor-selection-"));
    directories.push(directory);
    const path = join(directory, "vendor-selection-ledger.yaml");
    expect(loadVendorSelectionLedger(path)).toBeNull();
    writeFileSync(path, yamlStringify(ledger()));
    expect(loadVendorSelectionLedger(path)?.benchmark).toEqual({ slug: "database-eval", version: "v1" });
  });

  it("fails closed with useful paths for malformed YAML", () => {
    const directory = mkdtempSync(join(tmpdir(), "ax-vendor-selection-"));
    directories.push(directory);
    const path = join(directory, "vendor-selection-ledger.yaml");
    writeFileSync(path, "schema: ax.vendor-selection-ledger/v1\nentries: []\n");
    expect(() => loadVendorSelectionLedger(path)).toThrow(`Invalid vendor selection ledger at ${path}`);
  });
});
