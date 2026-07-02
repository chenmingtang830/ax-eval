/**
 * SDK surface-quality audit: deterministic checks over the declared SDK surface.
 *
 * Unlike CLI help-quality, this never executes product code. It inspects the pack
 * metadata that agents receive before using an SDK surface and asks whether the
 * SDK is self-describing enough to install, authenticate, find signatures, and
 * copy examples without falling back to raw HTTP or memory.
 */
import { REPORT_STYLE } from "../report-style.js";
import type { SdkSurface, SurfaceAuth, TargetPack } from "../schemas.js";

export type SdkQualityCategory =
  | "PACKAGE"
  | "INSTALL"
  | "REFERENCE"
  | "AUTH"
  | "EXAMPLES"
  | "TYPES";

export interface SdkQualityFinding {
  category: SdkQualityCategory;
  evidence: string;
  suggestion: string;
}

export interface SdkQualityAudit {
  title: string;
  packageName: string;
  language: string;
  totalFindings: number;
  byCategory: Record<SdkQualityCategory, number>;
  score: number;
  findings: SdkQualityFinding[];
}

const CATEGORIES: SdkQualityCategory[] = [
  "PACKAGE",
  "INSTALL",
  "REFERENCE",
  "AUTH",
  "EXAMPLES",
  "TYPES",
];

const WEIGHTS: Record<SdkQualityCategory, number> = {
  PACKAGE: 3,
  INSTALL: 2,
  REFERENCE: 3,
  AUTH: 3,
  EXAMPLES: 2,
  TYPES: 2,
};

const TOTAL_WEIGHT = CATEGORIES.reduce((sum, category) => sum + WEIGHTS[category], 0);

function finding(category: SdkQualityCategory, evidence: string, suggestion: string): SdkQualityFinding {
  return { category, evidence, suggestion: `[${category}] - ${suggestion}` };
}

function normalized(value: string | undefined): string {
  return (value ?? "").trim();
}

function knownPackageManagerInstall(sdk: SdkSurface): boolean {
  const language = sdk.language.toLowerCase();
  return Boolean(sdk.install) ||
    (language === "node" || language === "javascript" || language === "typescript" || language === "python");
}

function hasReference(sdk: SdkSurface): boolean {
  return Boolean(normalized(sdk.reference_url));
}

function hasExamples(sdk: SdkSurface): boolean {
  const refs = [sdk.examples_url, sdk.reference_url, sdk.install].map(normalized).join(" ");
  return /\b(examples?|quickstart|tutorial|readme|getting[-_ ]started)\b/i.test(refs);
}

function hasTypeOrSignatureSource(sdk: SdkSurface): boolean {
  const refs = [sdk.types_url, sdk.reference_url, sdk.package].map(normalized).join(" ");
  return /\b(type(docs?|script)?|typedoc|reference|api[-_ ]?docs?|signature|schema|declaration)\b/i.test(refs) ||
    ["typescript", "ts"].includes(sdk.language.toLowerCase());
}

function authIsDocumented(pack: TargetPack, surfaceAuth: SurfaceAuth | undefined): boolean {
  const auth = surfaceAuth ?? { kind: "inherit" as const };
  if (auth.kind === "inherit") {
    return pack.auth?.type === "none" || Boolean(pack.auth?.env || pack.auth?.env_aliases?.length);
  }
  if (auth.kind === "token") {
    return Boolean(auth.token_env || auth.token_env_aliases.length);
  }
  return Boolean(auth.client_id_env && auth.client_secret_env && auth.refresh_token_env && auth.token_url);
}

function authEvidence(pack: TargetPack, surfaceAuth: SurfaceAuth | undefined): string {
  const auth = surfaceAuth ?? { kind: "inherit" as const };
  if (auth.kind === "inherit") {
    return pack.auth?.type === "none"
      ? "Top-level auth is none."
      : `SDK inherits top-level auth env ${pack.auth?.env || "(missing)"}.`;
  }
  if (auth.kind === "token") {
    return `SDK token env is ${auth.token_env || "(missing)"}.`;
  }
  const missing = [
    ["client_id_env", auth.client_id_env],
    ["client_secret_env", auth.client_secret_env],
    ["refresh_token_env", auth.refresh_token_env],
    ["token_url", auth.token_url],
  ].filter(([, value]) => !value).map(([key]) => key);
  return missing.length ? `OAuth SDK auth is missing ${missing.join(", ")}.` : "OAuth SDK auth envs and token URL are declared.";
}

export function auditSdkSurfaceQuality(pack: TargetPack, sdk: SdkSurface = pack.surfaces!.sdk!): SdkQualityAudit {
  const findings: SdkQualityFinding[] = [];
  const packageName = normalized(sdk.package);
  const language = normalized(sdk.language);

  if (!packageName || !language) {
    findings.push(finding("PACKAGE", "SDK package or language is missing.", "Declare the official SDK package and runtime language agents must use."));
  }
  if (!knownPackageManagerInstall(sdk)) {
    findings.push(finding("INSTALL", "SDK install guidance is not explicit.", "Add an install command such as `npm install @vendor/sdk` or `pip install vendor-sdk`."));
  }
  if (!hasReference(sdk)) {
    findings.push(finding("REFERENCE", "SDK surface has no reference_url.", "Link the authoritative SDK reference, README, or generated API documentation."));
  }
  if (!authIsDocumented(pack, sdk.auth)) {
    findings.push(finding("AUTH", authEvidence(pack, sdk.auth), "Document how to construct and authenticate the SDK client from env vars in headless runs."));
  }
  if (!hasExamples(sdk)) {
    findings.push(finding("EXAMPLES", "SDK surface has no examples_url or example-oriented reference.", "Link copy-pastable SDK examples for common create/read/update workflows."));
  }
  if (!hasTypeOrSignatureSource(sdk)) {
    findings.push(finding("TYPES", "SDK surface does not point to type definitions or method signatures.", "Link type declarations, API reference pages, or signature docs so agents do not guess method names."));
  }

  const byCategory = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<SdkQualityCategory, number>;
  for (const item of findings) byCategory[item.category] += 1;
  const lost = findings.reduce((sum, item) => sum + WEIGHTS[item.category], 0);

  return {
    title: packageName || "SDK",
    packageName: packageName || "(missing)",
    language: language || "(missing)",
    totalFindings: findings.length,
    byCategory,
    score: Math.max(0, Math.round(100 * (1 - lost / TOTAL_WEIGHT))),
    findings,
  };
}

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function renderSdkQualitySection(audit: SdkQualityAudit): string {
  const prevalence = Object.entries(audit.byCategory)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([category, n]) => `<tr><td>${esc(category)}</td><td>${esc(n)}</td></tr>`)
    .join("");
  const rows = audit.findings.map((item) => `
    <details class="ax-endpoint">
      <summary><code class="ax-code">${esc(item.category)}</code></summary>
      <div class="ax-smell"><div class="ax-smell__head">${esc(item.evidence)}</div><p class="ax-smell__fix">${esc(item.suggestion)}</p></div>
    </details>`).join("");
  return `<section class="ax-section" id="sdk-quality">
    <h2>SDK quality</h2>
    <p class="ax-note">Score ${esc(audit.score)}/100 for <code class="ax-code">${esc(audit.packageName)}</code> (${esc(audit.language)}). This checks whether the declared SDK surface gives agents enough package, install, reference, auth, example, and type/signature guidance before execution.</p>
    ${prevalence ? `<table class="ax-table"><thead><tr><th>Finding category</th><th>Count</th></tr></thead><tbody>${prevalence}</tbody></table>` : `<p class="ax-empty">No SDK-quality findings.</p>`}
    ${rows}
  </section>`;
}

export function renderSdkQualityHtml(audit: SdkQualityAudit): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>SDK quality - ${esc(audit.title)}</title><style>${REPORT_STYLE}</style></head><body><main class="ax-main">${renderSdkQualitySection(audit)}</main></body></html>`;
}
