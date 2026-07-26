import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import {
  reclassifyEvidenceStrength,
  auditVendorExtracts,
  applyExtractAudit,
  auditAllExtracts,
} from "../src/authoring/extract-audit.js";
import { loadCapabilityExtract, writeSurfaceExtract } from "../src/authoring/artifact-persistence.js";

describe("extract-audit", () => {
  it("reclassifies METHOD /path quotes as direct even when mislabeled", () => {
    expect(reclassifyEvidenceStrength({
      doc_url: "https://api.example.com/v1",
      quote: "POST /v1/projects/{ref}/pause — Pauses the given project",
      strength: "derived_from_connection_surface",
    })).toBe("direct");
    // Real connection-derived cites stay derived.
    expect(reclassifyEvidenceStrength({
      doc_url: "https://docs.example/clusters",
      quote: "Create One Cluster",
      note: "exposes a MongoDB connection string for any MongoDB driver",
      strength: "derived_from_connection_surface",
    })).toBe("derived_from_connection_surface");
  });

  it("uses one policy for summary, marketing, SQL, SDK, and inferred evidence", () => {
    expect(reclassifyEvidenceStrength({
      doc_url: "https://docs.example.com/api-reference",
      quote: "Overview hub page that mirrors all API operations",
    })).toBe("summary_index");
    expect(reclassifyEvidenceStrength({
      doc_url: "https://example.com/products/database/features",
      quote: "Create amazing developer experiences.",
    })).toBe("marketing_claim");
    expect(reclassifyEvidenceStrength({
      doc_url: "https://docs.example.com/sql",
      quote: "CREATE TABLE widgets (id bigint primary key);",
    })).toBe("direct");
    expect(reclassifyEvidenceStrength({
      doc_url: "https://docs.example.com/sdk",
      quote: "Use collection.insertOne({ name: 'widget' }).",
    })).toBe("direct");
    expect(reclassifyEvidenceStrength({
      doc_url: "not a url",
      quote: "A capability may be available.",
    })).toBe("inferred");
  });

  it("drops all-weak caps, fills empty surfaces, strips sdk when surfaces.sdk is null", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-extract-audit-"));
    try {
      // Write raw YAML so we observe pre-write mislabels (writeCapabilityInventory
      // would already reclassify METHOD /path quotes).
      const invDir = resolve(dir, "ax-arena", "benchmark", "daeb", "v1", "extracts", "acme");
      mkdirSync(invDir, { recursive: true });
      writeFileSync(resolve(invDir, "capability-inventory.yaml"), yamlStringify({
        schema: "ax.capability-inventory/v1",
        vendor: "Acme",
        slug: "acme",
        category: "database",
        extracted_at: "2026-01-01T00:00:00.000Z",
        audit_status: "candidate",
        audit_notes: [],
        capabilities: [
          {
            capability_name: "pause-project",
            title: "Pause",
            description: "Pause a project.",
            resource_kind: "project",
            operation_kind: "update",
            surfaces_documented: ["api"],
            support_type: "native",
            evidence: [{
              doc_url: "https://docs.example/api",
              quote: "POST /v1/projects/{ref}/pause — pause",
              strength: "derived_from_connection_surface",
            }],
            extraction_provenance: { source: "official-docs", extracted_at: "2026-01-01T00:00:00.000Z", extractor: "test" },
          },
          {
            capability_name: "weak-only",
            title: "Weak",
            description: "Only inferred.",
            resource_kind: "row",
            operation_kind: "read",
            surfaces_documented: ["api"],
            support_type: "native",
            evidence: [{
              doc_url: "https://docs.example/overview",
              quote: "The API mirrors all Console functionality",
              strength: "inferred",
            }],
            extraction_provenance: { source: "official-docs", extracted_at: "2026-01-01T00:00:00.000Z", extractor: "test" },
          },
          {
            capability_name: "sql-via-driver",
            title: "SQL via driver",
            description: "Run SQL through a driver.",
            resource_kind: "row",
            operation_kind: "execute",
            surfaces_documented: ["sdk"],
            support_type: "native",
            evidence: [{
              doc_url: "https://docs.example/sql",
              quote: "Use INSERT to add rows",
              strength: "direct",
            }],
            extraction_provenance: { source: "official-docs", extracted_at: "2026-01-01T00:00:00.000Z", extractor: "test" },
          },
          {
            capability_name: "empty-surfaces",
            title: "Empty surfaces",
            description: "Has direct evidence but empty surfaces list.",
            resource_kind: "compute",
            operation_kind: "update",
            surfaces_documented: [],
            support_type: "native",
            evidence: [{
              doc_url: "https://docs.example/autoscaling",
              quote: "Enable autoscaling in the compute drawer",
              strength: "direct",
            }],
            extraction_provenance: { source: "official-docs", extracted_at: "2026-01-01T00:00:00.000Z", extractor: "test" },
          },
        ],
      }));
      writeSurfaceExtract(dir, {
        schema: "ax.surface-extract/v1",
        vendor: "Acme",
        slug: "acme",
        extracted_at: "2026-01-01T00:00:00.000Z",
        audit_status: "candidate",
        audit_notes: [],
        cli: {
          bin: "acme",
          install: "npm i -g acme",
          auth: { kind: "token", token_env: "ACME_TOKEN", token_env_aliases: [] },
        },
        sdk: null,
        mcp: null,
      });

      const audit = auditVendorExtracts(dir, "acme");
      expect(audit.findings.some((f) => f.code === "all_weak_evidence")).toBe(true);
      expect(audit.findings.some((f) => f.code === "sdk_surface_mismatch")).toBe(true);
      expect(audit.findings.some((f) => f.code === "strength_mislabeled")).toBe(true);

      applyExtractAudit(dir, audit);
      const loaded = loadCapabilityExtract(dir, "acme");
      expect(loaded).not.toBeNull();
      const names = loaded!.capabilities.map((c) => c.capability_name);
      expect(names).toContain("pause-project");
      expect(names).not.toContain("weak-only");
      expect(names).toContain("sql-via-driver");
      expect(names).toContain("empty-surfaces");
      const sql = loaded!.capabilities.find((c) => c.capability_name === "sql-via-driver")!;
      expect(sql.surfaces_documented).not.toContain("sdk");
      expect(sql.surfaces_documented).toContain("cli");
      const empty = loaded!.capabilities.find((c) => c.capability_name === "empty-surfaces")!;
      expect(empty.surfaces_documented).toEqual(["api"]);
      const pause = loaded!.capabilities.find((c) => c.capability_name === "pause-project")!;
      expect(pause.evidence[0]!.strength).toBe("direct");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auditAllExtracts returns empty when no extracts dir", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-extract-audit-empty-"));
    try {
      const report = auditAllExtracts(dir);
      expect(report.vendors).toEqual([]);
      expect(report.summary.errors).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
