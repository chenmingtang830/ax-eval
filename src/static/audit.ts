/**
 * Run the static checklist against a site and compute a 0–100 readiness score.
 *
 * Score = weighted share of checks passed. A check worth weight 3 counts three
 * times as much as a weight-1 check (plan.md §4 ranks the surfaces by impact).
 */
import { Fetcher, type FetcherOptions } from "./fetcher.js";
import { CHECKS, type StaticCheck } from "./checks.js";
import type { StaticAudit } from "./types.js";

export interface AuditOptions extends FetcherOptions {
  checks?: StaticCheck[];
}

export async function auditSite(site: string, opts: AuditOptions = {}): Promise<StaticAudit> {
  const checks = opts.checks ?? CHECKS;
  const fetcher = new Fetcher(opts);

  const results = [];
  for (const check of checks) {
    results.push(await check.run(site, fetcher));
  }

  const totalWeight = results.reduce((s, r) => s + r.weight, 0);
  const earned = results.reduce((s, r) => s + (r.passed ? r.weight : 0), 0);
  const score = totalWeight ? Math.round((earned / totalWeight) * 100) : 0;

  return {
    site,
    score,
    checks: results,
    source: fetcher.mode === "fixture" || fetcher.usedFixture ? "fixture" : "live",
  };
}
