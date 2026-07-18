export type EvidenceStrength =
  | "direct"
  | "summary_index"
  | "marketing_claim"
  | "derived_from_connection_surface"
  | "inferred";

export interface EvidenceStrengthInput {
  doc_url: string;
  quote: string;
  note?: string;
  declared_strength?: EvidenceStrength;
}

export interface EvidenceStrengthRecommendation {
  declared_strength: EvidenceStrength | null;
  recommended_strength: EvidenceStrength;
  disagrees_with_declared: boolean;
  reason:
    | "documented-http-operation"
    | "documented-sql-statement"
    | "documented-sdk-call"
    | "connection-surface-derivation"
    | "summary-index"
    | "marketing-page"
    | "insufficient-direct-evidence";
}

const HTTP_OPERATION = /\b(?:GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE)\s+\/[A-Za-z0-9_~!$&'()*+,;=:@%./{}-]*/i;
const SQL_STATEMENT = /\b(?:CREATE\s+(?:TABLE|DATABASE|SCHEMA|INDEX|ROLE|USER)|ALTER\s+(?:TABLE|DATABASE|SCHEMA|ROLE|USER)|DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|ROLE|USER)|SELECT\b[\s\S]{0,100}\bFROM\b|INSERT\s+INTO|UPDATE\b[\s\S]{0,80}\bSET\b|DELETE\s+FROM)\b/i;
const SDK_CALL = /\b(?:insertOne|insertMany|findOne|find|updateOne|updateMany|deleteOne|deleteMany|bulkWrite|aggregate|watch|createCollection)\s*\(/;
const CONNECTION_SURFACE = /\b(?:connection[-_\s]?string|connection\s+uri|wire\s+protocol|sql\s+surface|postgres(?:ql)?-compatible|mongodb\s+driver)\b/i;
const CONNECTION_CONTEXT = /\b(?:cluster|connection|deployment|database|project|driver)\b/i;
const EVIDENCE_STRENGTHS = new Set<EvidenceStrength>([
  "direct",
  "summary_index",
  "marketing_claim",
  "derived_from_connection_surface",
  "inferred",
]);

function urlPath(value: string): string {
  try {
    return new URL(value).pathname.toLowerCase().replace(/\/+$/, "") || "/";
  } catch {
    return "";
  }
}

function recommendation(input: EvidenceStrengthInput): Pick<EvidenceStrengthRecommendation, "recommended_strength" | "reason"> {
  const quote = input.quote.trim().slice(0, 20_000);
  const combined = `${quote} ${(input.note ?? "").slice(0, 20_000)}`;
  if (HTTP_OPERATION.test(quote)) return { recommended_strength: "direct", reason: "documented-http-operation" };
  if (SQL_STATEMENT.test(quote)) return { recommended_strength: "direct", reason: "documented-sql-statement" };
  if (SDK_CALL.test(quote)) return { recommended_strength: "direct", reason: "documented-sdk-call" };

  const path = urlPath(input.doc_url);
  if (path.endsWith("/llms.txt")
    || ((path.endsWith("/api-reference") || path.endsWith("/reference/api"))
      && /\b(?:overview|hub|index|mirrors\s+all)\b/i.test(quote))) {
    return { recommended_strength: "summary_index", reason: "summary-index" };
  }
  if (CONNECTION_SURFACE.test(combined) && CONNECTION_CONTEXT.test(combined)) {
    return { recommended_strength: "derived_from_connection_surface", reason: "connection-surface-derivation" };
  }
  if (/\/(?:products?|pricing|features?)(?:\/|$)/.test(path)) {
    return { recommended_strength: "marketing_claim", reason: "marketing-page" };
  }
  return { recommended_strength: "inferred", reason: "insufficient-direct-evidence" };
}

export function recommendEvidenceStrength(input: EvidenceStrengthInput): EvidenceStrengthRecommendation {
  if (typeof input.doc_url !== "string" || typeof input.quote !== "string") {
    throw new Error("evidence strength input requires string doc_url and quote fields");
  }
  if (input.note !== undefined && typeof input.note !== "string") {
    throw new Error("evidence strength note must be a string");
  }
  if (input.declared_strength !== undefined && !EVIDENCE_STRENGTHS.has(input.declared_strength)) {
    throw new Error("evidence declared_strength is invalid");
  }
  const result = recommendation(input);
  const declaredStrength = input.declared_strength ?? null;
  return {
    declared_strength: declaredStrength,
    ...result,
    disagrees_with_declared: declaredStrength !== null && declaredStrength !== result.recommended_strength,
  };
}
