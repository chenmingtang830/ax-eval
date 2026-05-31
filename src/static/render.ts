/** Render a static audit, and the static×behavioral "gap" headline. */
import type { RunReport } from "../runner.js";
import { passRate } from "../runner.js";
import type { StaticAudit } from "./types.js";

export function renderAudit(audit: StaticAudit): string {
  const lines: string[] = [];
  const title = `Static audit — ${audit.site}`;
  lines.push(title, "=".repeat(title.length), "");
  lines.push(`Agent-readiness score: ${audit.score}/100  (source: ${audit.source})`, "");

  const labelCol = Math.max(...audit.checks.map((c) => c.label.length), "check".length);
  for (const c of audit.checks) {
    const mark = c.passed ? "PASS" : "FAIL";
    lines.push(`  [${mark}] ${c.label.padEnd(labelCol)}  (w${c.weight})  ${c.detail}`);
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
  for (const h of report.harnesses) {
    const pct = Math.round(passRate(report, h) * 100);
    lines.push(`  Behavioral — ${h.padEnd(12)} ${pct}% of tasks`);
  }
  const bestBehavioral = Math.max(0, ...report.harnesses.map((h) => Math.round(passRate(report, h) * 100)));
  const gap = audit.score - bestBehavioral;
  lines.push("");
  if (gap > 0) {
    lines.push(`  → Readiness ${audit.score}, but best agent only ${bestBehavioral}% — a ${gap}-point gap.`);
    lines.push("    The plumbing is exposed; agents still can't reliably use it.");
  } else {
    lines.push(`  → No positive gap: behavioral success is not lagging static readiness here.`);
  }
  return lines.join("\n");
}
