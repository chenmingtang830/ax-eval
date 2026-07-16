import type { SurfaceId } from "../surface/types.js";
import type { CapabilityExtractResult } from "./capability-extract.js";
import { recommendEvidenceStrength } from "./evidence-strength.js";
import type { SurfaceExtractResult } from "./surface-extract.js";

type Capability = CapabilityExtractResult["capabilities"][number];
type AuditedSurface = Exclude<SurfaceId, "api">;

export interface ExtractAuditInput {
  slug: string;
  capabilities: CapabilityExtractResult | null;
  surfaces: SurfaceExtractResult | null;
}

export interface ExtractAuditFinding {
  artifact: "capability-extract" | "surface-extract";
  severity: "error" | "warn";
  code:
    | "capability_extract_missing"
    | "surface_extract_missing"
    | "extract_identity_mismatch"
    | "capability_direct_evidence_missing"
    | "capability_summary_evidence"
    | "capability_surfaces_missing"
    | "capability_surface_unavailable"
    | "capability_gui_only_evidence"
    | "support_mediated_backup"
    | "oauth_headless_unproven";
  message: string;
  capability_name?: string;
  surface?: AuditedSurface;
}

const GUI_ONLY = /\b(?:pgadmin|dbeaver|mongodb compass|tableplus|datagrip|ui editor|dashboard editor|web console)\b/i;
const COMMAND_LINE = /\b(?:psql|mongosh|cockroach sql|command[- ]line|terminal|shell)\b/i;
const BACKUP = /\b(?:backup|restore|point-in-time|snapshot)\b/i;
const SUPPORT_MEDIATED = /\b(?:contact support|support-mediated|support ticket|upon your request|paid tiers? only)\b/i;

function evidenceStrengths(capability: Capability) {
  return capability.evidence.map((evidence) => recommendEvidenceStrength(evidence).recommended_strength);
}

function capabilityFindings(capability: Capability): ExtractAuditFinding[] {
  const findings: ExtractAuditFinding[] = [];
  const strengths = evidenceStrengths(capability);
  if (!strengths.includes("direct")) {
    findings.push({
      artifact: "capability-extract",
      severity: "error",
      code: "capability_direct_evidence_missing",
      message: "Capability has no direct operation evidence",
      capability_name: capability.capability_name,
    });
  }
  if (strengths.includes("summary_index")) {
    findings.push({
      artifact: "capability-extract",
      severity: "warn",
      code: "capability_summary_evidence",
      message: "Capability cites summary-index evidence; prefer page-specific documentation",
      capability_name: capability.capability_name,
    });
  }
  if (capability.surfaces_documented.length === 0) {
    findings.push({
      artifact: "capability-extract",
      severity: "error",
      code: "capability_surfaces_missing",
      message: "Capability does not identify any documented execution surface",
      capability_name: capability.capability_name,
    });
  }
  const evidenceText = capability.evidence
    .map((evidence) => `${evidence.doc_url} ${evidence.quote} ${evidence.note ?? ""}`)
    .join("\n");
  if (GUI_ONLY.test(evidenceText) && !COMMAND_LINE.test(evidenceText) && !strengths.includes("direct")) {
    findings.push({
      artifact: "capability-extract",
      severity: "error",
      code: "capability_gui_only_evidence",
      message: "Capability relies on GUI-only evidence without a documented headless operation",
      capability_name: capability.capability_name,
    });
  }
  const capabilityText = `${capability.capability_name} ${capability.title}`;
  const supportText = capability.evidence.map((evidence) => `${evidence.quote} ${evidence.note ?? ""}`).join("\n");
  if (BACKUP.test(capabilityText)
    && (capability.support_type === "managed-surface" || SUPPORT_MEDIATED.test(supportText))) {
    findings.push({
      artifact: "capability-extract",
      severity: "warn",
      code: "support_mediated_backup",
      message: "Backup or recovery evidence is managed or support-mediated rather than self-service",
      capability_name: capability.capability_name,
    });
  }
  return findings;
}

function unavailableSurfaceFindings(
  capabilities: CapabilityExtractResult,
  surfaces: SurfaceExtractResult,
): ExtractAuditFinding[] {
  const findings: ExtractAuditFinding[] = [];
  for (const capability of capabilities.capabilities) {
    for (const surface of ["cli", "sdk", "mcp"] as const) {
      if (capability.surfaces_documented.includes(surface) && surfaces[surface] === null) {
        findings.push({
          artifact: "capability-extract",
          severity: "error",
          code: "capability_surface_unavailable",
          message: `Capability documents ${surface}, but the surface extract does not define it`,
          capability_name: capability.capability_name,
          surface,
        });
      }
    }
  }
  return findings;
}

function surfaceFindings(surfaces: SurfaceExtractResult): ExtractAuditFinding[] {
  return (["cli", "sdk", "mcp"] as const).flatMap((surface) => {
    const extracted = surfaces[surface];
    return extracted?.auth.kind === "oauth_app" ? [{
      artifact: "surface-extract" as const,
      severity: "warn" as const,
      code: "oauth_headless_unproven" as const,
      message: `${surface} uses OAuth app authentication without extract-level proof of unattended access`,
      surface,
    }] : [];
  });
}

export function auditExtracts(input: ExtractAuditInput): ExtractAuditFinding[] {
  const findings: ExtractAuditFinding[] = [];
  if (!input.capabilities) {
    findings.push({
      artifact: "capability-extract",
      severity: "error",
      code: "capability_extract_missing",
      message: `Capability extract is missing for ${input.slug}`,
    });
  }
  if (!input.surfaces) {
    findings.push({
      artifact: "surface-extract",
      severity: "error",
      code: "surface_extract_missing",
      message: `Surface extract is missing for ${input.slug}`,
    });
  }
  if (input.capabilities?.slug !== undefined && input.capabilities.slug !== input.slug) {
    findings.push({
      artifact: "capability-extract",
      severity: "error",
      code: "extract_identity_mismatch",
      message: `Capability extract identity does not match ${input.slug}`,
    });
  }
  if (input.surfaces?.slug !== undefined && input.surfaces.slug !== input.slug) {
    findings.push({
      artifact: "surface-extract",
      severity: "error",
      code: "extract_identity_mismatch",
      message: `Surface extract identity does not match ${input.slug}`,
    });
  }
  if (input.capabilities) {
    findings.push(...input.capabilities.capabilities.flatMap(capabilityFindings));
  }
  if (input.surfaces) findings.push(...surfaceFindings(input.surfaces));
  if (input.capabilities
    && input.surfaces
    && input.capabilities.slug === input.slug
    && input.surfaces.slug === input.slug
    && input.capabilities.vendor === input.surfaces.vendor) {
    findings.push(...unavailableSurfaceFindings(input.capabilities, input.surfaces));
  } else if (input.capabilities
    && input.surfaces
    && input.capabilities.slug === input.slug
    && input.surfaces.slug === input.slug
    && input.capabilities.vendor !== input.surfaces.vendor) {
    findings.push({
      artifact: "surface-extract",
      severity: "error",
      code: "extract_identity_mismatch",
      message: `Surface extract vendor does not match the capability extract for ${input.slug}`,
    });
  }
  return findings;
}
