/**
 * Run the static checklist against a site and compute a 0–100 readiness score.
 *
 * Score = weighted share of checks passed. A check worth weight 3 counts three
 * times as much as a weight-1 check (surfaces are weighted by impact).
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

  // Checks share no state; run them concurrently so audit latency is the slowest
  // check, not the sum (a dead host otherwise serializes ~8 timeouts).
  const results = await Promise.all(checks.map((check) => check.run(site, fetcher)));

  // Score = weighted % of *evaluable* checks passed. Errored checks (network
  // failures) are excluded from both numerator and denominator so flaky
  // connectivity can't masquerade as a genuine readiness deficit.
  const evaluable = results.filter((r) => r.status !== "error");
  const totalWeight = evaluable.reduce((s, r) => s + r.weight, 0);
  const earned = evaluable.reduce((s, r) => s + (r.status === "pass" ? r.weight : 0), 0);
  const score = totalWeight ? Math.round((earned / totalWeight) * 100) : 0;

  // Provenance from the checks that actually decided, not a global flag.
  const sources = new Set(evaluable.map((r) => r.source));
  const source: StaticAudit["source"] =
    sources.size === 0
      ? fetcher.mode
      : sources.size === 2
        ? "mixed"
        : sources.has("fixture")
          ? "fixture"
          : "live";

  return {
    site,
    score,
    checks: results,
    errored: results.length - evaluable.length,
    source,
  };
}
