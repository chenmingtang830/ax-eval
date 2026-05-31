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

/** The result of one static check against a site. */
export interface StaticCheckResult {
  /** Stable id, e.g. "llms-txt". */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Did the surface exist / pass? */
  passed: boolean;
  /** Contribution weight toward the score. */
  weight: Weight;
  /** Where we looked / what we found. */
  detail: string;
  /** The URL inspected (if any). */
  url?: string;
}

/** The full static audit of one site. */
export interface StaticAudit {
  site: string;
  /** 0–100 agent-readiness score (weighted % of checks passed). */
  score: number;
  checks: StaticCheckResult[];
  /** Whether results came from the live network or offline fixtures. */
  source: "live" | "fixture";
}
