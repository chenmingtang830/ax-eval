/**
 * Post-extract audit for Layer 0a artifacts (capability-inventory + surfaces).
 *
 * Deterministic checks catch the common failure modes we hit after seed+grounded
 * extracts: mislabeled Management-API evidence, empty surfaces_documented,
 * inventory↔surfaces SDK mismatch, incomplete headless auth. Optional LLM
 * repair is a follow-on; this module is the load-bearing gate before
 * synthesize-suite.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  auditCapabilityInventory,
  loadCapabilityInventory,
  writeCapabilityInventory,
  type CapabilityInventory,
  type CapabilityInventoryEntry,
} from "./methodology.js";
import {
  auditSurfaceExtract,
  loadSurfaceExtract,
  writeSurfaceExtract,
  type SurfaceExtractResult,
} from "./surface-extract.js";
import { daebExtractsDir } from "./benchmark-paths.js";

export type ExtractFindingSeverity = "error" | "warn" | "info";

export interface ExtractFinding {
  vendor: string;
  artifact: "capability-inventory" | "surfaces";
  severity: ExtractFindingSeverity;
  code: string;
  message: string;
  capability_name?: string;
  auto_fixable: boolean;
}

export interface VendorExtractAudit {
  vendor: string;
  slug: string;
  findings: ExtractFinding[];
  inventory?: CapabilityInventory;
  surfaces?: SurfaceExtractResult;
}

export interface ExtractAuditReport {
  vendors: VendorExtractAudit[];
  summary: { errors: number; warns: number; infos: number; autoFixable: number };
}

const METHOD_PATH_RE = /\b(GET|POST|PUT|PATCH|DELETE)\s+\//;

function looksConnectionDerivedEvidence(
  evidence: CapabilityInventoryEntry["evidence"][number],
): boolean {
  const text = `${evidence.doc_url} ${evidence.quote} ${evidence.note ?? ""}`.toLowerCase();
  return (
    /(connection[-_\s]?string|connection uri|wire protocol|sql surface|postgresql-compatible|mongodb driver)/i.test(text)
    && /(cluster|connection|deployment|project)/i.test(evidence.quote)
  );
}

/** Prefer METHOD /path quotes as direct when the model mislabeled them as derived. */
export function reclassifyEvidenceStrength(
  evidence: CapabilityInventoryEntry["evidence"][number],
): NonNullable<CapabilityInventoryEntry["evidence"][number]["strength"]> {
  const hasMethod = METHOD_PATH_RE.test(evidence.quote);
  if (evidence.strength === "derived_from_connection_surface" && hasMethod && !looksConnectionDerivedEvidence(evidence)) {
    return "direct";
  }
  if (evidence.strength) return evidence.strength;
  const url = evidence.doc_url.toLowerCase();
  if (url.endsWith("/llms.txt") || url.includes("/llms.txt")) return "summary_index";
  if (/api-reference\/?$|\/reference\/api\/?$/.test(url) && /mirrors all|overview|hub page/i.test(evidence.quote)) {
    return "summary_index";
  }
  if (/\/(products?|pricing|features?)\/?$/.test(new URL(evidence.doc_url, "https://example.invalid").pathname)) {
    return "marketing_claim";
  }
  if (looksConnectionDerivedEvidence(evidence)) return "derived_from_connection_surface";
  if (hasMethod) return "direct";
  if (/\b(CREATE|ALTER|DROP|SELECT|INSERT|UPDATE|DELETE|UPSERT|BEGIN|COMMIT|ROLLBACK)\b/i.test(evidence.quote)) {
    return "direct";
  }
  if (/\b(insertOne|insertMany|findOne|find|updateOne|updateMany|deleteOne|deleteMany|bulkWrite|aggregate|watch|createCollection)\b/.test(evidence.quote)) {
    return "direct";
  }
  return "inferred";
}

function listExtractSlugs(root: string): string[] {
  const dir = daebExtractsDir(root);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function auditInventoryFindings(
  slug: string,
  inventory: CapabilityInventory,
  surfaces: SurfaceExtractResult | null,
): { findings: ExtractFinding[]; inventory: CapabilityInventory } {
  const findings: ExtractFinding[] = [];
  const vendor = inventory.vendor;
  let caps: CapabilityInventoryEntry[] = inventory.capabilities.map((cap) => {
    const evidence = cap.evidence.map((item) => {
      const next = reclassifyEvidenceStrength(item);
      if (item.strength && item.strength !== next && next === "direct" && METHOD_PATH_RE.test(item.quote)) {
        findings.push({
          vendor,
          artifact: "capability-inventory",
          severity: "warn",
          code: "strength_mislabeled",
          message: `Evidence strength ${item.strength} → direct (METHOD /path quote)`,
          capability_name: cap.capability_name,
          auto_fixable: true,
        });
      }
      return { ...item, strength: next };
    });
    return { ...cap, evidence };
  });

  // Drop caps with no usable direct evidence and only overview/summary/inferred cites.
  const kept: CapabilityInventoryEntry[] = [];
  for (const cap of caps) {
    const hasDirect = cap.evidence.some((e) => e.strength === "direct");
    const surfs = cap.surfaces_documented ?? [];
    if (!surfs.length && hasDirect) {
      findings.push({
        vendor,
        artifact: "capability-inventory",
        severity: "warn",
        code: "empty_surfaces_documented",
        message: "surfaces_documented is empty; defaulting to [api]",
        capability_name: cap.capability_name,
        auto_fixable: true,
      });
      kept.push({ ...cap, surfaces_documented: ["api"] });
      continue;
    }
    if (!hasDirect) {
      findings.push({
        vendor,
        artifact: "capability-inventory",
        severity: "error",
        code: "all_weak_evidence",
        message: "No direct evidence — remove or re-extract before suite synthesis",
        capability_name: cap.capability_name,
        auto_fixable: true,
      });
      continue; // drop on apply
    }
    if (cap.evidence.some((e) => e.strength === "summary_index")) {
      findings.push({
        vendor,
        artifact: "capability-inventory",
        severity: "warn",
        code: "summary_index_evidence",
        message: "Has summary-index evidence; prefer page-specific docs",
        capability_name: cap.capability_name,
        auto_fixable: true,
      });
      // Keep direct evidence; drop summary_index rows when a direct cite exists.
      kept.push({
        ...cap,
        evidence: cap.evidence.filter((e) => e.strength !== "summary_index" || !hasDirect),
      });
      continue;
    }
    kept.push(cap);
  }
  caps = kept;

  if (surfaces && !surfaces.sdk) {
    let stripped = 0;
    caps = caps.map((cap) => {
      if (!cap.surfaces_documented.includes("sdk")) return cap;
      stripped++;
      const nextSurfaces = cap.surfaces_documented.filter((s) => s !== "sdk");
      // First-party SDK absent (e.g. Cockroach uses pg drivers): keep the cap
      // but attribute to cli when present, else api — never leave the list empty.
      const surfacesDocumented = nextSurfaces.length
        ? nextSurfaces
        : (surfaces.cli ? ["cli"] as const : ["api"] as const);
      return {
        ...cap,
        surfaces_documented: [...surfacesDocumented],
        support_type: cap.support_type === "native" ? "idiomatic-pattern" : cap.support_type,
      };
    });
    if (stripped) {
      findings.push({
        vendor,
        artifact: "capability-inventory",
        severity: "warn",
        code: "sdk_surface_mismatch",
        message: `${stripped} capabilities cited sdk but surfaces.yaml has sdk: null — stripped sdk attribution`,
        auto_fixable: true,
      });
    }
  }

  const audited = auditCapabilityInventory({
    ...inventory,
    capabilities: caps,
    audit_notes: [
      ...(inventory.audit_notes ?? []).filter((n) => !n.startsWith("Post-extract audit:")),
      `Post-extract audit: ${findings.filter((f) => f.artifact === "capability-inventory").length} inventory finding(s).`,
    ],
  });

  return { findings, inventory: audited };
}

function auditSurfaceFindings(slug: string, surfaces: SurfaceExtractResult): {
  findings: ExtractFinding[];
  surfaces: SurfaceExtractResult;
} {
  const findings: ExtractFinding[] = [];
  const vendor = surfaces.vendor;
  let next = { ...surfaces };

  const checkAuth = (
    label: "cli" | "sdk" | "mcp",
    surface: { auth: NonNullable<SurfaceExtractResult["cli"]>["auth"] } | null,
  ) => {
    if (!surface) return;
    const auth = surface.auth;
    if (auth.kind === "token" && !auth.token_env) {
      findings.push({
        vendor,
        artifact: "surfaces",
        severity: "warn",
        code: "token_env_missing",
        message: `${label} declares token auth but token_env is empty`,
        auto_fixable: label === "sdk" && /SUPABASE_KEY|SUPABASE_SERVICE/i.test(auth.instructions ?? ""),
      });
    }
    if (auth.kind === "oauth_app" && !(auth.client_id_env && auth.client_secret_env) && !auth.token_url) {
      findings.push({
        vendor,
        artifact: "surfaces",
        severity: "warn",
        code: "oauth_headless_incomplete",
        message: `${label} oauth_app lacks client_id/secret/token_url for headless use`,
        auto_fixable: false,
      });
    }
  };
  checkAuth("cli", next.cli);
  checkAuth("sdk", next.sdk);
  checkAuth("mcp", next.mcp);

  // Known safe autofixes for this vendor set.
  if (slug === "supabase" && next.sdk?.auth.kind === "token" && !next.sdk.auth.token_env) {
    next = {
      ...next,
      sdk: {
        ...next.sdk,
        auth: {
          ...next.sdk.auth,
          token_env: "SUPABASE_KEY",
          token_env_aliases: ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"],
        },
      },
    };
    findings.push({
      vendor,
      artifact: "surfaces",
      severity: "info",
      code: "token_env_filled",
      message: "sdk.token_env set to SUPABASE_KEY (aliases: service_role/anon)",
      auto_fixable: true,
    });
  }

  if (slug === "cockroachdb" && next.cli?.auth.kind === "oauth_app" && !next.cli.auth.client_id_env) {
    next = {
      ...next,
      cli: {
        ...next.cli,
        auth: {
          kind: "token",
          token_env: "COCKROACH_API_KEY",
          token_env_aliases: [],
          instructions:
            "ccloud interactive login is browser/device-code based. For headless/CI automation prefer the Cloud REST API with a service-account API key (COCKROACH_API_KEY / Authorization: Bearer). The CLI itself is not a fully non-interactive surface.",
        },
      },
    };
    findings.push({
      vendor,
      artifact: "surfaces",
      severity: "info",
      code: "cli_auth_normalized",
      message: "cli auth oauth_app→token (COCKROACH_API_KEY); CLI noted as non-headless",
      auto_fixable: true,
    });
  }

  const audited = auditSurfaceExtract({
    ...next,
    audit_notes: [
      ...(next.audit_notes ?? []).filter((n) => !n.startsWith("Post-extract audit:")),
      `Post-extract audit: ${findings.filter((f) => f.artifact === "surfaces").length} surface finding(s).`,
    ],
  });
  return { findings, surfaces: audited };
}

export function auditVendorExtracts(root: string, slug: string): VendorExtractAudit {
  const inventory = loadCapabilityInventory(root, slug);
  const surfaces = loadSurfaceExtract(root, slug);
  if (!inventory && !surfaces) {
    return {
      vendor: slug,
      slug,
      findings: [{
        vendor: slug,
        artifact: "capability-inventory",
        severity: "error",
        code: "missing_extracts",
        message: "No capability-inventory.yaml or surfaces.yaml",
        auto_fixable: false,
      }],
    };
  }
  const findings: ExtractFinding[] = [];
  let nextInv = inventory ?? undefined;
  let nextSurf = surfaces ?? undefined;
  if (inventory) {
    const r = auditInventoryFindings(slug, inventory, surfaces);
    findings.push(...r.findings);
    nextInv = r.inventory;
  } else {
    findings.push({
      vendor: slug,
      artifact: "capability-inventory",
      severity: "error",
      code: "missing_inventory",
      message: "capability-inventory.yaml missing",
      auto_fixable: false,
    });
  }
  if (surfaces) {
    const r = auditSurfaceFindings(slug, surfaces);
    findings.push(...r.findings);
    nextSurf = r.surfaces;
  } else {
    findings.push({
      vendor: slug,
      artifact: "surfaces",
      severity: "warn",
      code: "missing_surfaces",
      message: "surfaces.yaml missing",
      auto_fixable: false,
    });
  }
  return {
    vendor: nextInv?.vendor ?? nextSurf?.vendor ?? slug,
    slug,
    findings,
    inventory: nextInv,
    surfaces: nextSurf,
  };
}

export function auditAllExtracts(root: string, slugs?: string[]): ExtractAuditReport {
  const targets = slugs?.length ? slugs : listExtractSlugs(root);
  const vendors = targets.map((slug) => auditVendorExtracts(root, slug));
  const flat = vendors.flatMap((v) => v.findings);
  return {
    vendors,
    summary: {
      errors: flat.filter((f) => f.severity === "error").length,
      warns: flat.filter((f) => f.severity === "warn").length,
      infos: flat.filter((f) => f.severity === "info").length,
      autoFixable: flat.filter((f) => f.auto_fixable).length,
    },
  };
}

/** Apply autofixes from a prior auditVendorExtracts result and rewrite YAML. */
export function applyExtractAudit(root: string, audit: VendorExtractAudit): { inventoryPath?: string; surfacesPath?: string } {
  const out: { inventoryPath?: string; surfacesPath?: string } = {};
  if (audit.inventory) {
    // Mark still-candidate unless zero errors remain after apply.
    const remainingErrors = audit.findings.filter((f) => f.severity === "error" && !f.auto_fixable).length;
    const inventory: CapabilityInventory = {
      ...audit.inventory,
      audit_status: remainingErrors ? "needs-reextract" : "candidate",
    };
    out.inventoryPath = writeCapabilityInventory(root, inventory);
  }
  if (audit.surfaces) {
    out.surfacesPath = writeSurfaceExtract(root, audit.surfaces);
  }
  return out;
}

export function formatExtractAuditReport(report: ExtractAuditReport): string {
  const lines: string[] = [];
  lines.push(
    `Extract audit: ${report.vendors.length} vendor(s) — ` +
      `${report.summary.errors} error(s), ${report.summary.warns} warn(s), ` +
      `${report.summary.infos} info(s), ${report.summary.autoFixable} auto-fixable`,
  );
  for (const v of report.vendors) {
    if (!v.findings.length) {
      lines.push(`\n  ${v.slug}: clean`);
      continue;
    }
    lines.push(`\n  ${v.slug}: ${v.findings.length} finding(s)`);
    for (const f of v.findings) {
      const where = f.capability_name ? ` [${f.capability_name}]` : "";
      lines.push(`    - ${f.severity}/${f.code}${where}: ${f.message}${f.auto_fixable ? " (autofix)" : ""}`);
    }
  }
  return lines.join("\n");
}
