import { describe, expect, it } from "vitest";
import {
  CapabilityInventorySchema,
  TraceReviewMemoSchema,
  auditCapabilityInventory,
} from "../src/generate/methodology.js";
import { auditSurfaceExtract } from "../src/generate/surface-extract.js";

describe("suite methodology artifacts", () => {
  it("audits weak capability evidence before inventory publication", () => {
    const audited = auditCapabilityInventory(CapabilityInventorySchema.parse({
      vendor: "MongoDB Atlas",
      slug: "mongodb-atlas",
      category: "database",
      extracted_at: "2026-01-01T02:00:00.000Z",
      capabilities: [{
        capability_name: "document-insert",
        title: "Document insert",
        description: "Insert documents via the MongoDB driver.",
        resource_kind: "document",
        operation_kind: "create",
        surfaces_documented: ["api", "sdk"],
        support_type: "native",
        evidence: [{
          doc_url: "https://www.mongodb.com/docs/api/doc/atlas-admin-api-v2/",
          quote: "POST /api/atlas/v2/groups/{groupId}/clusters - Create One Cluster",
          note: "Cluster provisioning exposes a standard MongoDB connection string; insertOne is available via any MongoDB driver.",
        }],
        extraction_provenance: {
          source: "official-docs",
          extracted_at: "2026-01-01T00:00:00.000Z",
          extractor: "llm-capability-inventory-v1",
        },
      }, {
        capability_name: "view-creation",
        title: "View creation",
        description: "Create a view.",
        resource_kind: "view",
        operation_kind: "create",
        surfaces_documented: ["sdk", "cli"],
        support_type: "native",
        evidence: [{ doc_url: "https://docs.example/llms.txt", quote: "CREATE VIEW - Named queries" }],
        extraction_provenance: {
          source: "official-docs",
          extracted_at: "2026-01-01T02:00:00.000Z",
          extractor: "llm-capability-inventory-v1",
        },
      }],
    }));

    expect(audited.capabilities[0]?.surfaces_documented).toEqual(["sdk"]);
    expect(audited.capabilities[0]?.support_type).toBe("idiomatic-pattern");
    expect(audited.capabilities[0]?.evidence[0]?.strength).toBe("derived_from_connection_surface");
    expect(audited.capabilities[0]?.extraction_provenance.extracted_at).toBe("2026-01-01T02:00:00.000Z");
    expect(audited.capabilities[1]?.evidence[0]?.strength).toBe("summary_index");
    expect(audited.audit_notes.join("\n")).toMatch(/connection-derived data-plane/);
    expect(audited.audit_notes.join("\n")).toMatch(/summary-index evidence/);
  });

  it("audits suspicious surface auth before publication", () => {
    const audited = auditSurfaceExtract({
      vendor: "Neon",
      slug: "neon",
      extracted_at: "2026-01-01T00:00:00.000Z",
      cli: {
        bin: "neon",
        docs_url: "https://neon.com/docs/cli",
        auth: {
          kind: "inherit",
          token_env_aliases: [],
          instructions: "Point your MCP client at the server URL and approve access in the browser.",
        },
      },
      sdk: null,
      mcp: null,
    });

    expect(audited.schema).toBe("ax.surface-extract/v1");
    expect(audited.audit_notes.join("\n")).toMatch(/copied from another surface/);
  });



  it("requires explicit reviewer metadata and a full sample before trace review completion", () => {
    expect(TraceReviewMemoSchema.safeParse({
      schema: "ax.trace-review/v1",
      benchmark: "DAEB-1",
      generated_at: "2026-01-01T00:00:00.000Z",
      status: "completed",
      sample_size: 2,
      sample_ids: ["trace-1"],
      findings: [],
      summary: "Reviewed.",
    }).success).toBe(false);

    expect(TraceReviewMemoSchema.safeParse({
      schema: "ax.trace-review/v1",
      benchmark: "DAEB-1",
      generated_at: "2026-01-01T00:00:00.000Z",
      status: "completed",
      sample_size: 2,
      sample_ids: ["trace-1", "trace-2"],
      reviewer: "Reviewer",
      reviewed_at: "2026-01-01T01:00:00.000Z",
      commit_sha: "abcdef123456",
      findings: ["No blocker."],
      summary: "Reviewed.",
    }).success).toBe(true);
  });
});
