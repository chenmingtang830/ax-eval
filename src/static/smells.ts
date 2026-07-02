/**
 * Static **content-quality** assessment — the semantic-readiness axis.
 *
 * Discoverability (`audit` v0 / `discover` v2) answers *can an agent FIND the
 * surfaces?* This module answers the orthogonal question the Hermes paper raised
 * (Lima et al., *Making OpenAPI Documentation Agent-Ready*, EASE 2026,
 * arXiv:2605.14312): *once found, is the OpenAPI spec's CONTENT good enough for
 * an agent to USE?* Their finding — structural validity ≠ agent-readiness — is
 * exactly the gap this measures.
 *
 * It re-implements their 9-category smell taxonomy as **deterministic,
 * keyless heuristics** (no LLM, no network, fully testable). The richer
 * LLM-based / multi-agent variant and the bridge from a behavioral task failure
 * to the endpoint smell that caused it are deferred.
 *
 * Scope note: this covers the **OpenAPI** surface only, matching the paper.
 * Extending the same content-quality lens to MCP tool descriptions / CLI help /
 * SDK docstrings is future work, not done here.
 */
import { parse as parseYaml } from "yaml";
import { collectRefs, deref, HTTP_METHODS, resolveRef, type Json } from "../ingest/openapi-refs.js";
import { REPORT_STYLE } from "../report-style.js";

/** The Hermes taxonomy: 4 documentation smells + 5 REST smells. */
export type SmellCategory =
  | "LAZY"
  | "BLOATED"
  | "TANGLED"
  | "FRAGMENTED"
  | "PATH"
  | "METHOD"
  | "INPUT"
  | "RESPONSE"
  | "SECURITY";

export const SMELL_CATEGORIES: SmellCategory[] = [
  "LAZY",
  "BLOATED",
  "TANGLED",
  "FRAGMENTED",
  "PATH",
  "METHOD",
  "INPUT",
  "RESPONSE",
  "SECURITY",
];

/**
 * Per-category weight toward the content-quality score (impact on agent
 * reasoning). Calibrated against the paper's prevalence + how badly each smell
 * breaks autonomous consumption: RESPONSE/INPUT/LAZY are the most damaging
 * (an agent can't construct payloads or interpret returns); textual-excess
 * smells (BLOATED/TANGLED) and PATH are comparatively minor.
 */
export const SMELL_WEIGHTS: Record<SmellCategory, number> = {
  RESPONSE: 3,
  INPUT: 3,
  LAZY: 3,
  SECURITY: 2,
  FRAGMENTED: 2,
  METHOD: 2,
  PATH: 1,
  BLOATED: 1,
  TANGLED: 1,
};

const TOTAL_WEIGHT = SMELL_CATEGORIES.reduce((s, c) => s + SMELL_WEIGHTS[c], 0);

/** One detected smell on one endpoint: the evidence + a concrete fix, mirroring
 *  the paper's per-endpoint report (Appendix C: `[CATEGORY] - action`). */
export interface SmellFinding {
  category: SmellCategory;
  /** Why this endpoint exhibits the smell (the observed evidence). */
  evidence: string;
  /** Actionable fix, formatted `[CATEGORY] - <action>` like the paper. */
  suggestion: string;
}

export interface EndpointReport {
  method: string;
  path: string;
  smells: SmellFinding[];
}

export interface SpecQualityAudit {
  title: string;
  source: string;
  endpointsAnalyzed: number;
  totalSmells: number;
  /** # of endpoints exhibiting each smell (paper Table 2 shape). */
  byCategory: Record<SmellCategory, number>;
  /** 0–100 content-quality score: weighted share of (endpoint × category)
   *  checks that are clean. 100 = no smells anywhere. */
  score: number;
  endpoints: EndpointReport[];
}

function str(x: unknown): string {
  return typeof x === "string" ? x : "";
}

/** Strip HTML/markdown noise so length/density heuristics see real prose. */
function plain(x: unknown): string {
  return str(x)
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*`_>|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const VERB = "(get|create|update|delete|list|fetch|set|new|remove|add|search|find|retrieve)";

function sug(category: SmellCategory, action: string): string {
  return `[${category}] - ${action}`;
}

// ---------------------------------------------------------------------------
// Per-category detectors. Each returns 0..1 finding for one endpoint.
// ---------------------------------------------------------------------------

function detectLazy(op: Json): SmellFinding | null {
  const summary = plain(op.summary);
  const description = plain(op.description);
  const reasons: string[] = [];
  if (!summary) reasons.push("no summary");
  else if (summary.length < 12) reasons.push(`summary is very short ("${summary}")`);
  else if (new RegExp(`^${VERB}\\b`, "i").test(summary) && summary.length < 18)
    reasons.push(`summary is generic ("${summary}")`);
  if (!description) reasons.push("no description");
  else if (description.length < 25) reasons.push("description is too brief to convey purpose");
  if (reasons.length === 0) return null;
  return {
    category: "LAZY",
    evidence: `Superficial documentation: ${reasons.join("; ")}.`,
    suggestion: sug(
      "LAZY",
      "Add a descriptive summary and a 1–2 sentence description stating the endpoint's purpose, behavior, and a usage note.",
    ),
  };
}

function detectBloated(op: Json): SmellFinding | null {
  const description = plain(op.description);
  if (description.length <= 1500) return null;
  return {
    category: "BLOATED",
    evidence: `Description is excessively long (${description.length} chars) with likely low information density.`,
    suggestion: sug("BLOATED", "Tighten the description; move long detail into examples or linked reference docs."),
  };
}

function detectTangled(op: Json): SmellFinding | null {
  const description = plain(op.description);
  if (description.length < 200) return null;
  const concerns = [
    /\b(auth|token|permission|scope|oauth|credential)/i,
    /\b(error|exception|fail|invalid|\b[45]\d\d\b)/i,
    /\b(deprecat|rate limit|pagination|migrat)/i,
  ].filter((re) => re.test(description)).length;
  if (concerns < 2) return null;
  return {
    category: "TANGLED",
    evidence: "Description mixes multiple unrelated concerns (e.g. behavior, auth, error handling) in one fragment.",
    suggestion: sug("TANGLED", "Split mixed concerns into dedicated fields/sections (behavior vs auth vs errors)."),
  };
}

function detectFragmented(root: Json, opNode: unknown): SmellFinding | null {
  const broken = collectRefs(opNode).filter((ref) => ref.startsWith("#/") && resolveRef(root, ref) === undefined);
  if (broken.length === 0) return null;
  return {
    category: "FRAGMENTED",
    evidence: `Broken/unresolved local reference(s): ${[...new Set(broken)].slice(0, 3).join(", ")}.`,
    suggestion: sug("FRAGMENTED", "Define the referenced schema/component in the spec, or fix the broken $ref."),
  };
}

function detectPath(path: string): SmellFinding | null {
  const segments = path.split("/").filter((s) => s && !s.startsWith("{"));
  const offending = segments.find(
    (s) => new RegExp(`^${VERB}([_-]|[A-Z]|$)`, "i").test(s) || new RegExp(`${VERB}[A-Z]`).test(s),
  );
  if (!offending) return null;
  return {
    category: "PATH",
    evidence: `Action-oriented URI segment "${offending}" — the path encodes a verb rather than a resource.`,
    suggestion: sug("PATH", "Use resource-oriented nouns (e.g. POST /orders), not action verbs in the path (/createNewOrder)."),
  };
}

function detectMethod(method: string, path: string, op: Json): SmellFinding | null {
  const m = method.toLowerCase();
  const opId = str(op.operationId);
  const hay = `${path} ${opId}`.toLowerCase();
  const reasons: string[] = [];
  if (m === "get" && op.requestBody) reasons.push("GET defines a requestBody");
  if (m === "get" && /\b(create|new|update|delete|set|add)\b|create|update|delete/.test(hay))
    reasons.push("GET used for what looks like a create/mutate operation");
  if (m === "post" && /\b(update|edit|modify)\b|update|edit/.test(hay) && path.trimEnd().endsWith("}"))
    reasons.push("POST used for an update (PUT/PATCH is more idiomatic)");
  if (reasons.length === 0) return null;
  return {
    category: "METHOD",
    evidence: `Non-idiomatic HTTP method: ${reasons.join("; ")}.`,
    suggestion: sug("METHOD", "Align the method with semantics: GET=read, POST=create, PUT/PATCH=update, DELETE=delete."),
  };
}

function detectInput(root: Json, op: Json): SmellFinding | null {
  const undocumented: string[] = [];
  let total = 0;

  const params = Array.isArray(op.parameters) ? op.parameters : [];
  for (const pRaw of params) {
    const p = deref(root, pRaw);
    if (!p) continue;
    const name = str(p.name) || "(unnamed)";
    if (String(p.in ?? "").toLowerCase() === "header") continue; // headers are infra, not task input
    total++;
    if (plain(p.description).length < 3) undocumented.push(name);
  }

  const rb = deref(root, op.requestBody);
  const appJson = (deref(root, rb?.content) as Json | undefined)?.["application/json"] as Json | undefined;
  const schema = deref(root, appJson?.schema);
  const props = deref(root, schema?.properties) as Json | undefined;
  if (props) {
    for (const [name, vRaw] of Object.entries(props)) {
      total++;
      const prop = deref(root, vRaw);
      if (!prop || plain(prop.description).length < 3) undocumented.push(name);
    }
  }

  if (total === 0 || undocumented.length === 0) return null;
  return {
    category: "INPUT",
    evidence: `${undocumented.length} of ${total} input field(s) lack a semantic description: ${undocumented
      .slice(0, 6)
      .join(", ")}${undocumented.length > 6 ? ", …" : ""}.`,
    suggestion: sug(
      "INPUT",
      "Document each parameter/body field: meaning, format (e.g. UUID, ISO-8601), constraints, and whether required.",
    ),
  };
}

function detectResponse(root: Json, op: Json): SmellFinding | null {
  const responses = deref(root, op.responses) as Json | undefined;
  if (!responses || Object.keys(responses).length === 0) {
    return {
      category: "RESPONSE",
      evidence: "No responses are documented at all.",
      suggestion: sug("RESPONSE", "Document the success and error responses with concrete schemas and status codes."),
    };
  }
  const codes = Object.keys(responses);
  const successCode = codes.find((c) => /^2\d\d$/.test(c));
  const reasons: string[] = [];

  if (!successCode) reasons.push("no 2xx success response documented");
  if (!codes.some((c) => /^[45]\d\d$/.test(c) || /default/i.test(c)))
    reasons.push("no error (4xx/5xx) responses documented");

  if (successCode) {
    const resp = deref(root, responses[successCode]);
    const desc = plain(resp?.description);
    if (!desc || /^(success(ful)?( response)?|ok|created|no content)\.?$/i.test(desc))
      reasons.push(`success response description is generic ("${desc || "—"}")`);
    const content = deref(root, resp?.content) as Json | undefined;
    const schema = deref(root, (content?.["application/json"] as Json | undefined)?.schema);
    if (schema && isGenericObject(root, schema)) reasons.push("success schema is a generic untyped object (opaque payload)");
  }

  if (reasons.length === 0) return null;
  return {
    category: "RESPONSE",
    evidence: `Weak response documentation: ${reasons.join("; ")}.`,
    suggestion: sug(
      "RESPONSE",
      "Describe response payloads with a concrete schema (not a generic object), document error codes, and clarify success/error semantics.",
    ),
  };
}

/** A schema is "generic/opaque" if it's a bare object with no properties, or a
 *  status/data envelope whose `data` is itself a bare object — the exact
 *  pattern the paper flags (Appendix B `GenericResponse { status, data }`). */
function isGenericObject(root: Json, schema: Json): boolean {
  const props = deref(root, schema.properties) as Json | undefined;
  if (schema.type === "object" && (!props || Object.keys(props).length === 0)) return true;
  if (props) {
    const data = deref(root, props.data);
    if (data) {
      const dataProps = deref(root, data.properties) as Json | undefined;
      if (data.type === "object" && (!dataProps || Object.keys(dataProps).length === 0)) return true;
    }
  }
  return false;
}

function detectSecurity(root: Json, op: Json): SmellFinding | null {
  const opSecurity = Array.isArray(op.security) ? op.security : undefined;
  const globalSecurity = Array.isArray(root.security) ? (root.security as unknown[]) : undefined;
  const effective = opSecurity ?? globalSecurity;

  if (!effective || effective.length === 0) {
    // No security at all is only a smell if the spec declares schemes (i.e.
    // the API does have auth, this op just doesn't reference it).
    const schemes = deref(root, (root.components as Json | undefined)?.securitySchemes);
    if (!schemes || Object.keys(schemes).length === 0) return null; // genuinely public — not a smell
    return {
      category: "SECURITY",
      evidence: "No security requirement is documented for this endpoint, though the spec defines security schemes.",
      suggestion: sug("SECURITY", "Declare the required security scheme on the operation (or globally)."),
    };
  }

  // A scheme is referenced — check it carries operational guidance.
  const schemes = deref(root, (root.components as Json | undefined)?.securitySchemes) as Json | undefined;
  const referenced = effective.flatMap((req) =>
    req && typeof req === "object" ? Object.keys(req as Json) : [],
  );
  for (const name of referenced) {
    const scheme = deref(root, schemes?.[name]);
    if (scheme && plain(scheme.description).length < 10) {
      return {
        category: "SECURITY",
        evidence: `Security scheme "${name}" is defined but lacks operational guidance (how to obtain credentials / scopes).`,
        suggestion: sug(
          "SECURITY",
          "Document how to obtain credentials, required scopes/permissions, and any access constraints for the scheme.",
        ),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Endpoint + spec assembly.
// ---------------------------------------------------------------------------

function analyzeEndpoint(root: Json, method: string, path: string, opNode: unknown): EndpointReport {
  const op = (opNode ?? {}) as Json;
  const smells: SmellFinding[] = [];
  const push = (f: SmellFinding | null) => {
    if (f) smells.push(f);
  };
  push(detectLazy(op));
  push(detectBloated(op));
  push(detectTangled(op));
  push(detectFragmented(root, opNode));
  push(detectPath(path));
  push(detectMethod(method, path, op));
  push(detectInput(root, op));
  push(detectResponse(root, op));
  push(detectSecurity(root, op));
  return { method: method.toUpperCase(), path, smells };
}

/**
 * Parse an OpenAPI document (JSON or YAML text) and run the heuristic smell
 * taxonomy over every operation. Pure + offline — the unit of analysis is the
 * endpoint (method + path), exactly as in the paper.
 */
export function auditSpecQuality(specText: string, source = "spec"): SpecQualityAudit {
  const root = (parseYaml(specText) ?? {}) as Json;
  const info = (root.info ?? {}) as Json;
  const paths = (root.paths ?? {}) as Json;

  const endpoints: EndpointReport[] = [];
  for (const [path, itemRaw] of Object.entries(paths)) {
    const item = deref(root, itemRaw);
    if (!item) continue;
    for (const method of HTTP_METHODS) {
      if (!item[method]) continue;
      endpoints.push(analyzeEndpoint(root, method, path, item[method]));
    }
  }

  const byCategory = Object.fromEntries(SMELL_CATEGORIES.map((c) => [c, 0])) as Record<SmellCategory, number>;
  let totalSmells = 0;
  let earned = 0;
  for (const ep of endpoints) {
    const present = new Set(ep.smells.map((s) => s.category));
    totalSmells += ep.smells.length;
    for (const c of SMELL_CATEGORIES) {
      if (present.has(c)) byCategory[c]++;
      else earned += SMELL_WEIGHTS[c];
    }
  }

  const score = endpoints.length === 0 ? 0 : Math.round((earned / (endpoints.length * TOTAL_WEIGHT)) * 100);

  return {
    title: str(info.title) || source,
    source,
    endpointsAnalyzed: endpoints.length,
    totalSmells,
    byCategory,
    score,
    endpoints,
  };
}

/** Markdown render mirroring `renderDiscovery`: headline score, prevalence
 *  table (paper Table 2 shape), then the worst endpoints with fixes. */
export function renderSpecQuality(a: SpecQualityAudit, opts: { maxEndpoints?: number } = {}): string {
  const lines: string[] = [];
  lines.push(`# Content-quality audit (OpenAPI smells) — ${a.title}`);
  lines.push("");
  lines.push(
    `Analyzed **${a.endpointsAnalyzed}** endpoint(s) from ${a.source} — content-quality score **${a.score}/100** ` +
      `(${a.totalSmells} smells total). Higher = more semantically agent-ready.`,
  );
  lines.push("");
  lines.push("## Smell prevalence");
  lines.push("");
  lines.push("| smell | weight | endpoints | % |");
  lines.push("|---|---|---|---|");
  const total = a.endpointsAnalyzed || 1;
  for (const c of [...SMELL_CATEGORIES].sort((x, y) => a.byCategory[y] - a.byCategory[x])) {
    const n = a.byCategory[c];
    lines.push(`| ${c} | ${SMELL_WEIGHTS[c]} | ${n} | ${Math.round((n / total) * 100)}% |`);
  }
  lines.push("");

  const offenders = a.endpoints.filter((e) => e.smells.length > 0).sort((x, y) => y.smells.length - x.smells.length);
  const shown = offenders.slice(0, opts.maxEndpoints ?? 15);
  if (offenders.length === 0) {
    lines.push("No content-quality smells detected — the spec is semantically agent-ready. 🎉");
    return lines.join("\n");
  }
  lines.push(`## Endpoints with smells (${shown.length} of ${offenders.length})`);
  lines.push("");
  for (const ep of shown) {
    lines.push(`### \`${ep.method} ${ep.path}\` — ${ep.smells.map((s) => s.category).join(", ")}`);
    for (const s of ep.smells) {
      lines.push(`- **${s.category}**: ${s.evidence}`);
      lines.push(`  - ${s.suggestion}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML rendering — the content-quality audit as a self-contained report in the
// shared `ax-*` design system (same visual contract as the behavioral + the
// competitive reports). Pure: takes an audit, returns an HTML string.
// ---------------------------------------------------------------------------

/** Human-readable label + one-line "why it matters" for each smell category,
 *  used in the findings + recommendations sections. */
const CATEGORY_LABEL: Record<SmellCategory, string> = {
  LAZY: "Superficial documentation",
  BLOATED: "Over-long descriptions",
  TANGLED: "Mixed concerns in one field",
  FRAGMENTED: "Broken / unresolved references",
  PATH: "Action-oriented URIs",
  METHOD: "Non-idiomatic HTTP methods",
  INPUT: "Undocumented inputs",
  RESPONSE: "Weak response documentation",
  SECURITY: "Unclear auth requirements",
};

function escH(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function codeH(value: unknown): string {
  return `<code class="ax-code">${escH(value)}</code>`;
}

/** Score → pass/warn/fail card modifier. ≥80 usable, ≥50 mixed, else weak. */
function scoreClass(score: number): string {
  if (score >= 80) return "ax-card--pass";
  if (score >= 50) return "ax-card--warn";
  return "ax-card--fail";
}

/** Prevalence heat: more endpoints affected = worse (inverted vs the
 *  competitive heat where higher is better). 0% = green, ≤33% = amber, else red. */
function prevalenceHeat(n: number, total: number): string {
  const pctv = total ? Math.round((n / total) * 100) : 0;
  if (n === 0) return `<span class="ax-heat ax-heat--hi">0%</span>`;
  const cls = pctv >= 50 ? "ax-heat--lo" : "ax-heat--mid";
  return `<span class="ax-heat ${cls}">${pctv}%</span>`;
}

/** Weight 3 → high, 2 → med, 1 → low — drives the recommendation accent. */
function weightPriority(weight: number): "high" | "med" | "low" {
  return weight >= 3 ? "high" : weight === 2 ? "med" : "low";
}

/** A representative fix for a category (first one observed), minus the
 *  `[CATEGORY] - ` prefix the per-endpoint suggestions carry. */
function representativeFix(a: SpecQualityAudit, category: SmellCategory): string {
  for (const ep of a.endpoints) {
    const f = ep.smells.find((s) => s.category === category);
    if (f) return f.suggestion.replace(/^\[[A-Z]+\]\s*-\s*/, "");
  }
  return "Improve this aspect of the spec.";
}

/** Build 2–3 plain-text findings from the audit (mirrors the behavioral report). */
function buildSmellFindings(a: SpecQualityAudit): string[] {
  const findings: string[] = [];
  const total = a.endpointsAnalyzed || 1;

  findings.push(
    a.score >= 80
      ? `Content-quality score is ${a.score}/100 — the spec is largely usable by an agent as-is.`
      : a.score >= 50
        ? `Content-quality score is ${a.score}/100 — structurally valid but with gaps that will slow an agent down.`
        : `Content-quality score is ${a.score}/100 — the spec is published but not yet agent-ready.`,
  );

  const ranked = [...SMELL_CATEGORIES]
    .filter((c) => a.byCategory[c] > 0)
    .sort((x, y) => a.byCategory[y] - a.byCategory[x] || SMELL_WEIGHTS[y] - SMELL_WEIGHTS[x]);
  if (ranked.length) {
    const top = ranked[0]!;
    findings.push(
      `Most common issue: ${CATEGORY_LABEL[top].toLowerCase()} (${top}) on ${a.byCategory[top]} of ${total} endpoint(s).`,
    );
  }

  if (a.byCategory.FRAGMENTED > 0) {
    findings.push(
      `${a.byCategory.FRAGMENTED} endpoint(s) have broken or unresolved $refs — an agent can't expand those schemas at all.`,
    );
  } else if (ranked.length === 0) {
    findings.push("No content-quality smells detected — the spec is semantically agent-ready.");
  }

  return findings.slice(0, 3);
}

function renderSmellHeader(a: SpecQualityAudit, generatedAt: string): string {
  const meta: Array<[string, string]> = [
    ["generated", escH(generatedAt)],
    ["source", codeH(a.source)],
    ["endpoints_analyzed", escH(a.endpointsAnalyzed)],
    ["smells_total", escH(a.totalSmells)],
    ["taxonomy", codeH("Hermes (Lima et al., EASE 2026)")],
  ];
  const rows = meta.map(([k, v]) => `<div><dt>${escH(k)}</dt><dd>${v}</dd></div>`).join("\n      ");
  return `<header class="ax-header">
    <div class="ax-eyebrow">Agent-readiness · content quality</div>
    <h1 class="ax-title">Is <span class="ax-target">${escH(a.title)}</span> documented well enough for an agent to use?</h1>
    <p class="ax-subtitle">Structural validity isn't the same as agent-readiness. We score the OpenAPI spec's <em>content</em> against the Hermes smell taxonomy — can an agent actually understand each endpoint, its inputs, and its responses?</p>
    <dl class="ax-meta">
      ${rows}
    </dl>
  </header>`;
}

function renderSmellScorecard(a: SpecQualityAudit): string {
  const verdict =
    a.score >= 80
      ? `The spec scores ${a.score}/100 on content quality — most endpoints carry enough semantic detail for an agent to construct calls and interpret results on its own.`
      : a.score >= 50
        ? `The spec scores ${a.score}/100 on content quality — it's structurally valid, but ${a.totalSmells} documentation/REST smells across ${a.endpointsAnalyzed} endpoints will make an agent guess.`
        : `The spec scores ${a.score}/100 on content quality — being published isn't enough; ${a.totalSmells} smells across ${a.endpointsAnalyzed} endpoints block reliable autonomous use.`;

  const offenders = a.endpoints.filter((e) => e.smells.length > 0).length;
  const offenderPct = a.endpointsAnalyzed ? Math.round((offenders / a.endpointsAnalyzed) * 100) : 0;
  const densityClass = offenderPct === 0 ? "ax-card--pass" : offenderPct >= 50 ? "ax-card--fail" : "ax-card--warn";

  const cards = [
    `<div class="ax-card ${scoreClass(a.score)}">
        <span class="ax-card__value">${escH(a.score)}</span>
        <span class="ax-card__label">Content quality</span>
        <span class="ax-card__sub">0–100 · higher = more agent-ready</span>
      </div>`,
    `<div class="ax-card">
        <span class="ax-card__value">${escH(a.endpointsAnalyzed)}</span>
        <span class="ax-card__label">Endpoints analyzed</span>
        <span class="ax-card__sub">method × path</span>
      </div>`,
    `<div class="ax-card ${densityClass}">
        <span class="ax-card__value">${escH(offenders)}</span>
        <span class="ax-card__label">Endpoints with smells</span>
        <span class="ax-card__sub">${escH(offenderPct)}% of analyzed · ${escH(a.totalSmells)} smells total</span>
      </div>`,
  ];

  return `<section class="ax-section ax-scorecard-section">
    <h2>Summary</h2>
    <p class="ax-verdict">${escH(verdict)}</p>
    <div class="ax-scorecard">
      ${cards.join("\n      ")}
    </div>
  </section>`;
}

function renderSmellFindings(a: SpecQualityAudit): string {
  const findings = buildSmellFindings(a);
  const body = findings.length
    ? `<ul class="ax-findings">${findings.map((f) => `<li class="ax-finding">${escH(f)}</li>`).join("")}</ul>`
    : `<p class="ax-empty">No findings.</p>`;
  return `<section class="ax-section">
    <h2>Key findings</h2>
    ${body}
  </section>`;
}

/** One recommendation per smell category present, prioritized by weight. */
function renderSmellRecommendations(a: SpecQualityAudit): string {
  const total = a.endpointsAnalyzed || 1;
  const present = [...SMELL_CATEGORIES]
    .filter((c) => a.byCategory[c] > 0)
    .sort((x, y) => SMELL_WEIGHTS[y] - SMELL_WEIGHTS[x] || a.byCategory[y] - a.byCategory[x]);
  if (!present.length) {
    return `<section class="ax-section">
    <h2>Recommendations</h2>
    <p class="ax-empty">No smells detected — nothing to fix. Keep the bar high as the surface grows.</p>
  </section>`;
  }
  const items = present
    .map((c) => {
      const priority = weightPriority(SMELL_WEIGHTS[c]);
      const n = a.byCategory[c];
      const pctv = Math.round((n / total) * 100);
      return `<li class="ax-rec ax-rec--${priority}">
        <span class="ax-rec__badge">${escH(priority)}</span>
        <div class="ax-rec__body">
          <h3 class="ax-rec__title">${escH(CATEGORY_LABEL[c])} <span class="ax-task__diff">[${escH(c)}] · ${escH(n)}/${escH(a.endpointsAnalyzed)} endpoints (${escH(pctv)}%)</span></h3>
          <p class="ax-rec__detail">${escH(representativeFix(a, c))}</p>
        </div>
      </li>`;
    })
    .join("\n      ");
  return `<section class="ax-section">
    <h2>Recommendations</h2>
    <ol class="ax-recs">${items}</ol>
  </section>`;
}

/** The prevalence `<table>` (paper Table-2 shape), no surrounding section — so
 *  both the standalone report and the embedded pipeline section share one table. */
function smellPrevalenceTable(a: SpecQualityAudit): string {
  const total = a.endpointsAnalyzed;
  const rows = [...SMELL_CATEGORIES]
    .sort((x, y) => a.byCategory[y] - a.byCategory[x] || SMELL_WEIGHTS[y] - SMELL_WEIGHTS[x])
    .map(
      (c) => `<tr>
        <td>${codeH(c)} <span class="ax-task__diff">${escH(CATEGORY_LABEL[c])}</span></td>
        <td>${escH(SMELL_WEIGHTS[c])}</td>
        <td>${escH(a.byCategory[c])}</td>
        <td>${prevalenceHeat(a.byCategory[c], total)}</td>
      </tr>`,
    )
    .join("");
  return `<table class="ax-table">
      <thead><tr><th>smell</th><th>weight</th><th>endpoints</th><th>% affected</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** The per-endpoint `<details>` blocks (worst-first), no surrounding section.
 *  Returns the rendered blocks plus how many were shown vs. total offenders. */
function smellEndpointDetails(
  a: SpecQualityAudit,
  maxEndpoints: number,
): { blocks: string; shown: number; offenders: number } {
  const offenders = a.endpoints
    .filter((e) => e.smells.length > 0)
    .sort((x, y) => y.smells.length - x.smells.length);
  const shown = offenders.slice(0, maxEndpoints);
  const blocks = shown
    .map((ep) => {
      const tags = ep.smells
        .map((s) => `<span class="ax-tag">${escH(s.category)}</span>`)
        .join("");
      const smells = ep.smells
        .map(
          (s) => `<div class="ax-smell">
          <div class="ax-smell__head">${escH(s.category)} — ${escH(s.evidence)}</div>
          <p class="ax-smell__fix">→ ${escH(s.suggestion.replace(/^\[[A-Z]+\]\s*-\s*/, ""))}</p>
        </div>`,
        )
        .join("");
      return `<details class="ax-task">
        <summary>${codeH(`${ep.method} ${ep.path}`)} <span class="ax-tags">${tags}</span></summary>
        ${smells}
      </details>`;
    })
    .join("\n      ");
  return { blocks, shown: shown.length, offenders: offenders.length };
}

function renderSmellPrevalence(a: SpecQualityAudit): string {
  return `<section class="ax-section">
    <h2>Smell prevalence</h2>
    <p class="ax-note">How many of the ${escH(a.endpointsAnalyzed)} analyzed endpoint(s) exhibit each smell (the paper's Table-2 shape). Weight is the smell's impact on autonomous use — RESPONSE / INPUT / LAZY are weighted heaviest because they most directly block an agent from constructing calls or interpreting results.</p>
    ${smellPrevalenceTable(a)}
  </section>`;
}

function renderSmellAppendix(a: SpecQualityAudit, maxEndpoints: number): string {
  const { blocks, shown, offenders } = smellEndpointDetails(a, maxEndpoints);
  if (!offenders) {
    return `<section class="ax-section ax-appendix">
    <h2>Appendix — per-endpoint smells</h2>
    <p class="ax-empty">No endpoints exhibit any smell. 🎉</p>
  </section>`;
  }
  const note =
    offenders > shown
      ? `<p class="ax-note">Showing the ${shown} worst of ${offenders} endpoint(s) with smells.</p>`
      : "";
  return `<section class="ax-section ax-appendix">
    <h2>Appendix — per-endpoint smells (${shown} of ${offenders})</h2>
    ${note}
    ${blocks}
  </section>`;
}

/**
 * The content-quality audit condensed into a SINGLE embeddable `<section>` for
 * the main verify-generated report (which already has its own header, summary
 * scorecard, findings and recommendations). One verdict line, the prevalence
 * table, and the worst endpoints behind a sub-head — so it reads as the "is the
 * spec usable?" axis alongside discoverability + behavioral success, without
 * duplicating the standalone report's chrome.
 */
export function renderContentQualitySection(
  a: SpecQualityAudit,
  opts: { maxEndpoints?: number } = {},
): string {
  const verdict =
    a.score >= 80
      ? `Content quality ${a.score}/100 — most of the ${a.endpointsAnalyzed} endpoints carry enough semantic detail for an agent to construct calls and read results on its own.`
      : a.score >= 50
        ? `Content quality ${a.score}/100 — the spec is structurally valid, but ${a.totalSmells} smell(s) across ${a.endpointsAnalyzed} endpoints will make an agent guess.`
        : `Content quality ${a.score}/100 — being published isn't enough; ${a.totalSmells} smell(s) across ${a.endpointsAnalyzed} endpoints block reliable autonomous use.`;
  const { blocks, shown, offenders } = smellEndpointDetails(a, opts.maxEndpoints ?? 8);
  const detail = offenders
    ? `<h3 class="ax-subhead">Suggested fixes — endpoints with smells (${shown} of ${offenders})</h3>
    ${blocks}`
    : `<p class="ax-empty">No content-quality smells detected — the spec is semantically agent-ready. 🎉</p>`;
  return `<section class="ax-section" id="content-quality">
    <h2>Content quality (spec smells)</h2>
    <p class="ax-note">Discoverability asks whether an agent can <em>find</em> the docs; this asks whether the OpenAPI spec, once found, is <em>usable</em>. Scored against the Hermes smell taxonomy (Lima et al., EASE 2026) on <code class="ax-code">${escH(a.source)}</code>. Each entry below is a <strong>suggested fix</strong> (the <code class="ax-code">→</code> line) the API owner can apply to make the spec more agent-ready.</p>
    <p class="ax-verdict">${escH(verdict)}</p>
    <h3 class="ax-subhead">Smell prevalence</h3>
    ${smellPrevalenceTable(a)}
    ${detail}
  </section>`;
}

/**
 * Render the content-quality audit as a self-contained HTML report in the
 * shared `ax-*` design system. Structure: header · summary scorecard · key
 * findings · recommendations (per smell category) · prevalence table ·
 * per-endpoint appendix. All interpolated text is escaped.
 */
export function renderSpecQualityHtml(
  a: SpecQualityAudit,
  opts: { maxEndpoints?: number; generatedAt?: string } = {},
): string {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const body = [
    renderSmellHeader(a, generatedAt),
    `<main class="ax-main-inner">`,
    renderSmellScorecard(a),
    renderSmellFindings(a),
    renderSmellRecommendations(a),
    renderSmellPrevalence(a),
    renderSmellAppendix(a, opts.maxEndpoints ?? 20),
    `</main>`,
  ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AX eval — content quality — ${escH(a.title)}</title>
<style>${REPORT_STYLE}</style>
</head>
<body>
<div class="ax-main">
${body}
</div>
</body>
</html>
`;
}
