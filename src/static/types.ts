/**
 * Static (agent-readiness / AEO) audit types.
 *
 * "Static" eval asks: is the plumbing even exposed for an agent to use? It does
 * NOT drive an agent — it just inspects the product's public surfaces (does
 * llms.txt exist? is there an OpenAPI spec? an MCP server? etc.). Each check
 * borrows from the Cloudflare Agent Readiness + axd.md dimensions (plan.md §4).
 *
 * Contrast with behavioral eval (the harness matrix), which actually makes an
 * agent do tasks. The product's headline is the *gap* between the two:
 * "readiness 92, but task success 3/10".
 */

/** How important a check is to the overall readiness score. */
export type Weight = 1 | 2 | 3;

/** Outcome of a check. `error` ≠ `fail`: the surface couldn't be evaluated
 *  (network/timeout), so it must not be scored as a genuine absence. */
export type CheckStatus = "pass" | "fail" | "error";

/** The result of one static check against a site. */
export interface StaticCheckResult {
  /** Stable id, e.g. "llms-txt". */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Did the surface pass, genuinely fail, or fail to be evaluated? */
  status: CheckStatus;
  /** Contribution weight toward the score. */
  weight: Weight;
  /** Where we looked / what we found. */
  detail: string;
  /** The URL inspected (if any). */
  url?: string;
  /** Whether the deciding response came from the live network or a fixture. */
  source: "live" | "fixture";
}

/** The full static audit of one site. */
export interface StaticAudit {
  site: string;
  /** 0–100 agent-readiness score: weighted % of *evaluable* checks passed.
   *  Errored checks are excluded from both numerator and denominator. */
  score: number;
  checks: StaticCheckResult[];
  /** How many checks could not be evaluated (network errors). */
  errored: number;
  /** Provenance: "live" if all evaluable checks hit the network, "fixture" if
   *  all came from fixtures, "mixed" if both. */
  source: "live" | "fixture" | "mixed";
}
