import type { CapabilityInventoryEntry } from "ax-eval";

export type CapabilityEvidence = CapabilityInventoryEntry["evidence"][number];

const METHOD_PATH_RE = /\b(GET|POST|PUT|PATCH|DELETE)\s+\//;
const SQL_STATEMENT_RE = /\b(CREATE|ALTER|DROP|SELECT|INSERT|UPDATE|DELETE|UPSERT|BEGIN|COMMIT|ROLLBACK)\b/i;
const SDK_CALL_RE = /\b(insertOne|insertMany|findOne|find|updateOne|updateMany|deleteOne|deleteMany|bulkWrite|aggregate|watch|createCollection)\b/;
const CONNECTION_SURFACE_RE = /(connection[-_\s]?string|connection uri|wire protocol|sql surface|postgresql-compatible|mongodb driver|any mongodb driver)/i;
const CONNECTION_CONTEXT_RE = /(cluster|connection|deployment|project)/i;

export function evidenceText(evidence: CapabilityEvidence): string {
  return `${evidence.doc_url} ${evidence.quote} ${evidence.note ?? ""}`.toLowerCase();
}

export function hasDocumentedHttpMethodPath(quote: string): boolean {
  return METHOD_PATH_RE.test(quote);
}

function looksConnectionDerivedEvidence(evidence: CapabilityEvidence): boolean {
  return CONNECTION_SURFACE_RE.test(evidenceText(evidence))
    && CONNECTION_CONTEXT_RE.test(evidence.quote);
}

/** Apply the one canonical evidence-strength policy used by every arena audit. */
export function classifyEvidenceStrength(
  evidence: CapabilityEvidence,
): NonNullable<CapabilityEvidence["strength"]> {
  const hasMethodPath = hasDocumentedHttpMethodPath(evidence.quote);
  if (evidence.strength === "derived_from_connection_surface"
    && hasMethodPath
    && !looksConnectionDerivedEvidence(evidence)) {
    return "direct";
  }
  if (evidence.strength) return evidence.strength;

  const url = evidence.doc_url.toLowerCase();
  if (url.endsWith("/llms.txt") || url.includes("/llms.txt")) return "summary_index";
  if (/api-reference\/?$|\/reference\/api\/?$/.test(url)
    && /mirrors all|overview|hub page/i.test(evidence.quote)) {
    return "summary_index";
  }
  if (/\/(products?|pricing|features?)\/?$/.test(new URL(evidence.doc_url, "https://example.invalid").pathname)) {
    return "marketing_claim";
  }
  if (looksConnectionDerivedEvidence(evidence)) return "derived_from_connection_surface";
  if (hasMethodPath || SQL_STATEMENT_RE.test(evidence.quote) || SDK_CALL_RE.test(evidence.quote)) return "direct";
  return "inferred";
}
