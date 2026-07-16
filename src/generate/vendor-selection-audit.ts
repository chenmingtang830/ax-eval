import { SURFACE_IDS, type SurfaceId } from "../surface/types.js";
import type { CapabilityExtractResult } from "./capability-extract.js";
import type { SurfaceExtractResult } from "./surface-extract.js";
import type { VendorSelectionLedger } from "./vendor-selection.js";

export interface VendorSelectionAuditArtifacts {
  capabilities: ReadonlyMap<string, CapabilityExtractResult>;
  surfaces: ReadonlyMap<string, SurfaceExtractResult>;
  resetVerified: ReadonlySet<string>;
}

export interface VendorSelectionFinding {
  slug: string;
  severity: "error";
  code:
    | "core_capability_extract_missing"
    | "core_surface_extract_missing"
    | "capability_extract_identity_mismatch"
    | "surface_extract_identity_mismatch"
    | "core_benchmark_surface_unproven"
    | "core_headless_auth_unproven"
    | "core_reset_feasibility_unproven";
  message: string;
}

function identityMatches(
  entry: { slug: string; vendor: string },
  artifact: { slug: string; vendor: string },
): boolean {
  return artifact.slug === entry.slug && artifact.vendor === entry.vendor;
}

function documentedSurfaces(capabilities: CapabilityExtractResult): Set<SurfaceId> {
  return new Set(capabilities.capabilities.flatMap((capability) => capability.surfaces_documented));
}

function evidencedSurfaces(
  capabilities: CapabilityExtractResult,
  surfaces: SurfaceExtractResult,
): SurfaceId[] {
  const documented = documentedSurfaces(capabilities);
  return SURFACE_IDS.filter((surface) => {
    if (!documented.has(surface)) return false;
    if (surface === "api") return true;
    return surfaces[surface] !== null;
  });
}

function hasHeadlessAuth(surfaces: SurfaceExtractResult, available: readonly SurfaceId[]): boolean {
  return available.some((surface) => {
    if (surface === "api") return false;
    const auth = surfaces[surface]?.auth;
    return auth?.kind === "inherit" || auth?.kind === "token";
  });
}

export function auditVendorSelectionEvidence(
  ledger: VendorSelectionLedger,
  artifacts: VendorSelectionAuditArtifacts,
): VendorSelectionFinding[] {
  const findings: VendorSelectionFinding[] = [];
  for (const entry of ledger.entries) {
    if (entry.status !== "core") continue;
    const capabilities = artifacts.capabilities.get(entry.slug);
    const surfaces = artifacts.surfaces.get(entry.slug);

    if (!capabilities) {
      findings.push({
        slug: entry.slug,
        severity: "error",
        code: "core_capability_extract_missing",
        message: `Core vendor ${entry.slug} requires a capability extract`,
      });
    } else if (!identityMatches(entry, capabilities)) {
      findings.push({
        slug: entry.slug,
        severity: "error",
        code: "capability_extract_identity_mismatch",
        message: `Capability extract identity does not match core vendor ${entry.slug}`,
      });
    }

    if (!surfaces) {
      findings.push({
        slug: entry.slug,
        severity: "error",
        code: "core_surface_extract_missing",
        message: `Core vendor ${entry.slug} requires a surface extract`,
      });
    } else if (!identityMatches(entry, surfaces)) {
      findings.push({
        slug: entry.slug,
        severity: "error",
        code: "surface_extract_identity_mismatch",
        message: `Surface extract identity does not match core vendor ${entry.slug}`,
      });
    }

    if (entry.eligibility.reset_feasibility === "yes" && !artifacts.resetVerified.has(entry.slug)) {
      findings.push({
        slug: entry.slug,
        severity: "error",
        code: "core_reset_feasibility_unproven",
        message: `Core vendor ${entry.slug} has no verified reset evidence`,
      });
    }

    if (!capabilities || !surfaces || !identityMatches(entry, capabilities) || !identityMatches(entry, surfaces)) {
      continue;
    }
    const available = evidencedSurfaces(capabilities, surfaces);
    if (entry.eligibility.benchmark_surface === "yes" && available.length === 0) {
      findings.push({
        slug: entry.slug,
        severity: "error",
        code: "core_benchmark_surface_unproven",
        message: `Core vendor ${entry.slug} has no documented capability on an available benchmark surface`,
      });
    }
    if (entry.eligibility.headless_auth === "yes" && !hasHeadlessAuth(surfaces, available)) {
      findings.push({
        slug: entry.slug,
        severity: "error",
        code: "core_headless_auth_unproven",
        message: `Core vendor ${entry.slug} has no documented non-OAuth headless surface`,
      });
    }
  }
  return findings;
}
