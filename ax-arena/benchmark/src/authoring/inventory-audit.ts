import {
  CAPABILITY_INVENTORY_SCHEMA_VERSION,
  CapabilityEvidenceSchema,
  CapabilityInventorySchema,
  type CapabilityInventory,
  type CapabilityInventoryEntry,
} from "ax-eval";
import type { z } from "zod";

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

function evidenceText(evidence: z.infer<typeof CapabilityEvidenceSchema>): string {
  return `${evidence.doc_url} ${evidence.quote} ${evidence.note ?? ""}`.toLowerCase();
}

function looksConnectionDerived(evidence: z.infer<typeof CapabilityEvidenceSchema>): boolean {
  const text = evidenceText(evidence);
  return (
    /(connection[-_\s]?string|connection uri|wire protocol|sql surface|postgresql-compatible|mongodb driver|any mongodb driver)/i.test(text)
    && /(cluster|connection|deployment|project)/i.test(evidence.quote)
  );
}

function inferEvidenceStrength(evidence: z.infer<typeof CapabilityEvidenceSchema>): NonNullable<z.infer<typeof CapabilityEvidenceSchema>["strength"]> {
  const hasMethodPath = /\b(GET|POST|PUT|PATCH|DELETE)\s+\//.test(evidence.quote);
  // Models sometimes stamp Management-API METHOD /path quotes as
  // derived_from_connection_surface. Upgrade those unless the cite really is
  // about exposing a wire/driver connection.
  if (evidence.strength === "derived_from_connection_surface" && hasMethodPath && !looksConnectionDerived(evidence)) {
    return "direct";
  }
  if (evidence.strength) return evidence.strength;
  const url = evidence.doc_url.toLowerCase();
  if (url.endsWith("/llms.txt") || url.includes("/llms.txt")) return "summary_index";
  if (/\/(products?|pricing|features?)\/?$/.test(new URL(evidence.doc_url, "https://example.invalid").pathname)) return "marketing_claim";
  if (looksConnectionDerived(evidence)) return "derived_from_connection_surface";
  if (hasMethodPath) return "direct";
  if (/\b(CREATE|ALTER|DROP|SELECT|INSERT|UPDATE|DELETE|UPSERT|BEGIN|COMMIT|ROLLBACK)\b/i.test(evidence.quote)) return "direct";
  if (/\b(insertOne|insertMany|findOne|find|updateOne|updateMany|deleteOne|deleteMany|bulkWrite|aggregate|watch|createCollection)\b/.test(evidence.quote)) {
    return "direct";
  }
  return "inferred";
}

function isConnectionDerivedDataPlane(capability: CapabilityInventoryEntry): boolean {
  const text = capability.evidence.map(evidenceText).join(" ");
  return /(connection[-_\s]?string|connection uri|wire protocol|postgresql-compatible|mongodb driver|any mongodb driver)/i.test(text)
    && capability.surfaces_documented.includes("api")
    && (capability.surfaces_documented.includes("sdk") || capability.surfaces_documented.includes("cli"));
}

export function auditCapabilityInventory(inventory: CapabilityInventory): CapabilityInventory {
  const auditNotes = [...(inventory.audit_notes ?? [])];
  let weakEvidenceCount = 0;
  let dataPlaneDowngradeCount = 0;
  let summaryIndexCount = 0;

  const capabilities = inventory.capabilities.map((capability) => {
    const evidence = capability.evidence.map((item) => ({
      ...item,
      strength: inferEvidenceStrength(item),
    }));
    if (evidence.some((item) => item.strength !== "direct")) weakEvidenceCount++;
    if (evidence.some((item) => item.strength === "summary_index")) summaryIndexCount++;

    let surfacesDocumented = [...capability.surfaces_documented];
    let supportType = capability.support_type;
    const allEvidenceWeak = evidence.every((item) => item.strength !== "direct");
    const connectionDerived = isConnectionDerivedDataPlane({ ...capability, evidence });

    if (connectionDerived) {
      surfacesDocumented = surfacesDocumented.filter((surface) => surface !== "api");
      dataPlaneDowngradeCount++;
    }
    if (supportType === "native" && allEvidenceWeak) {
      supportType = evidence.some((item) => item.strength === "marketing_claim") ? "unknown" : "idiomatic-pattern";
    }

    return {
      ...capability,
      surfaces_documented: uniq(surfacesDocumented),
      support_type: supportType,
      evidence,
      extraction_provenance: {
        ...capability.extraction_provenance,
        extracted_at: capability.extraction_provenance.extracted_at === "2026-01-01T00:00:00.000Z"
          ? inventory.extracted_at
          : capability.extraction_provenance.extracted_at,
      },
    };
  });

  if (weakEvidenceCount) {
    auditNotes.push(`${weakEvidenceCount} capabilities include non-direct evidence and require reviewer confirmation before publication.`);
  }
  if (dataPlaneDowngradeCount) {
    auditNotes.push(`${dataPlaneDowngradeCount} connection-derived data-plane capabilities were removed from REST api attribution and downgraded unless directly cited.`);
  }
  if (summaryIndexCount) {
    auditNotes.push(`${summaryIndexCount} capabilities cite summary-index evidence such as llms.txt; replace with page-specific docs before publication.`);
  }

  return CapabilityInventorySchema.parse({
    ...inventory,
    schema: CAPABILITY_INVENTORY_SCHEMA_VERSION,
    audit_status: inventory.audit_status ?? "candidate",
    audit_notes: uniq(auditNotes),
    capabilities,
  });
}
