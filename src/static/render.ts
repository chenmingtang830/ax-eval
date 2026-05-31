/** Render a static audit, and the static×behavioral "gap" headline. */
import type { RunReport } from "../runner.js";
import { passRate } from "../runner.js";
import type { CheckStatus, StaticAudit } from "./types.js";

const MARK: Record<CheckStatus, string> = { pass: "PASS", fail: "FAIL", error: "ERR " };

export function renderAudit(audit: StaticAudit): string {
  const lines: string[] = [];
  const title = `Static audit — ${audit.site}`;
  lines.push(title, "=".repeat(title.length), "");
  const errNote = audit.errored ? `, ${audit.errored} not evaluated` : "";
  lines.push(`Agent-readiness score: ${audit.score}/100  (source: ${audit.source}${errNote})`, "");

  const labelCol = Math.max(...audit.checks.map((c) => c.label.length), "check".length);
  for (const c of audit.checks) {
    lines.push(`  [${MARK[c.status]}] ${c.label.padEnd(labelCol)}  (w${c.weight})  ${c.detail}`);
  }
  if (audit.errored) {
    lines.push("", `Note: ${audit.errored} check(s) could not be reached and are excluded from the score.`);
  }
  return lines.join("\n");
}

/**
 * The headline of the whole product: put the static readiness score next to the
 * behavioral pass rate. A high static score with low task success is the "gap"
 * that proves "exposed ≠ usable" (plan.md §4).
 */
export function renderGap(audit: StaticAudit, report: RunReport): string {
  const lines: string[] = [];
  lines.push("The gap (static readiness vs. behavioral success)", "-".repeat(49), "");
  lines.push(`  Static agent-readiness:  ${audit.score}/100`);

  const synthetic = new Set(report.synthetic ?? []);
  for (const h of report.harnesses) {
    const ran = report.results.some((r) => r.harness === h);
    const tag = synthetic.has(h) ? " (synthetic control)" : "";
    // "not run" is distinct from "0% pass": a harness with no results was never
    // attempted, so don't report it as failing every task.
    const label = ran ? `${Math.round(passRate(report, h) * 100)}% of tasks` : "not run";
    lines.push(`  Behavioral — ${h.padEnd(12)} ${label}${tag}`);
  }
  lines.push("");

  // The gap compares readiness against the best *real-agent* harness that
  // actually ran — excluding synthetic controls (e.g. a perfect mock), whose
  // by-construction success would otherwise erase the gap.
  const realRan = report.harnesses.filter(
    (h) => !synthetic.has(h) && report.results.some((r) => r.harness === h),
  );
  if (realRan.length === 0) {
    lines.push("  → No real-agent harness ran; gap not measurable (only synthetic controls present).");
    return lines.join("\n");
  }

  const bestBehavioral = Math.max(...realRan.map((h) => Math.round(passRate(report, h) * 100)));
  const gap = audit.score - bestBehavioral;
  if (gap > 0) {
    lines.push(`  → Readiness ${audit.score}, but best agent only ${bestBehavioral}% — a ${gap}-point gap.`);
    lines.push("    The plumbing is exposed; agents still can't reliably use it.");
  } else {
    lines.push(`  → No positive gap: behavioral success is not lagging static readiness here.`);
  }
  return lines.join("\n");
}
