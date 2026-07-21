import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  coreVendorSlugs,
  loadVendorSelectionLedger,
  VendorSelectionLedgerSchema,
} from "../src/generate/vendor-selection.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("DAEB vendor selection ledger", () => {
  it("loads the purposive core/research/excluded cohort", () => {
    const ledger = loadVendorSelectionLedger(ROOT);
    expect(ledger?.methodology.sampling).toBe("purposive-stratified");
    expect(coreVendorSlugs(ROOT)).toEqual([
      "neon",
      "cockroachdb",
      "turso",
      "supabase",
      "insforge",
      "nile",
    ]);
    expect(ledger?.entries.filter((entry) => entry.status === "research").map((entry) => entry.slug))
      .toEqual(["mongodb-atlas", "convex"]);
    expect(ledger?.entries.filter((entry) => entry.status === "excluded").map((entry) => entry.slug))
      .toEqual(["planetscale", "xata"]);
  });

  it("rejects core vendors without a persistent free sandbox", () => {
    expect(VendorSelectionLedgerSchema.safeParse({
      schema: "ax.vendor-selection-ledger/v1",
      benchmark: "DAEB-1",
      generated_at: "2026-01-01T00:00:00.000Z",
      methodology: {
        sampling: "purposive-stratified",
        population: "Managed databases.",
        core_rule: "Core rule.",
        research_rule: "Research rule.",
        exclusion_rule: "Exclusion rule.",
      },
      entries: [
        {
          slug: "paid-only",
          vendor: "Paid Only",
          status: "core",
          stratum: "sql",
          rationale: "Test.",
          eligibility: {
            managed_service: true,
            persistent_free_sandbox: false,
            headless_auth: "yes",
            benchmark_surface: "yes",
            reset_feasibility: "unknown",
          },
          sources: ["https://example.test"],
        },
        {
          slug: "free",
          vendor: "Free",
          status: "core",
          stratum: "sql",
          rationale: "Test.",
          eligibility: {
            managed_service: true,
            persistent_free_sandbox: true,
            headless_auth: "yes",
            benchmark_surface: "yes",
            reset_feasibility: "unknown",
          },
          sources: ["https://example.test"],
        },
      ],
    }).success).toBe(false);
  });
});
