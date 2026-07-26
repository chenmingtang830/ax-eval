import {
  CAPABILITY_INVENTORY_SCHEMA_VERSION,
  CapabilityInventorySchema,
  type CapabilityInventory,
  type CapabilityInventoryEntry,
} from "ax-eval";
import { classifyEvidenceStrength, evidenceText } from "./evidence-strength.js";

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
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
      strength: classifyEvidenceStrength(item),
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
