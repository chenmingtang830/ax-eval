/** Render a run as a human-readable matrix + failure summary (text/markdown). */
import { matrix, type RunReport } from "./runner.js";

export function render(report: RunReport): string {
  const harnesses = report.harnesses;
  // Reuse the canonical grid builder so the matrix and runner can't drift.
  // A cell is `undefined` when that (task, harness) pair was never run.
  const grid = matrix(report);
  const taskIds = Object.keys(grid);

  const lines: string[] = [];
  const title = `AX eval — ${report.pack} v${report.packVersion}`;
  lines.push(title, "=".repeat(title.length), "");

  if (taskIds.length === 0) {
    lines.push("(no results)");
    return lines.join("\n");
  }

  // A cell shows PASS/FAIL when run, or "—" when the pair was never attempted
  // (so the matrix can't disagree with the pass-rate denominator below).
  const cell = (tid: string, h: string): string => {
    const v = grid[tid]![h];
    return v === undefined ? "—" : v ? "PASS" : "FAIL";
  };

  // Matrix table.
  const tcol = Math.max(...taskIds.map((t) => t.length), "task".length);
  const header = "task".padEnd(tcol) + "  " + harnesses.map((h) => center(h, 10)).join("  ");
  lines.push(header, "-".repeat(header.length));
  for (const tid of taskIds) {
    const cells = harnesses.map((h) => center(cell(tid, h), 10));
    lines.push(tid.padEnd(tcol) + "  " + cells.join("  "));
  }

  // Pass rates — denominator is tasks actually attempted by that harness.
  lines.push("", "Pass rate by harness:");
  for (const h of harnesses) {
    const total = taskIds.filter((t) => grid[t]![h] !== undefined).length;
    const passed = taskIds.filter((t) => grid[t]![h] === true).length;
    const pct = total ? Math.round((passed / total) * 100) : 0;
    lines.push(`  ${h.padEnd(12)} ${passed}/${total}  (${pct}%)`);
  }

  // Most-failed tasks — the "what to fix" hint.
  const fails = taskIds
    .map((tid) => ({ tid, n: harnesses.filter((h) => grid[tid]![h] === false).length }))
    .filter((f) => f.n > 0)
    .sort((a, b) => b.n - a.n);
  if (fails.length) {
    lines.push("", "Most-failed tasks (candidate fixes):");
    for (const { tid, n } of fails) {
      lines.push(`  ${tid}: failed on ${n}/${harnesses.length} harnesses`);
    }
  }

  return lines.join("\n");
}

function center(s: string, width: number): string {
  if (s.length >= width) return s;
  const left = Math.floor((width - s.length) / 2);
  return " ".repeat(left) + s + " ".repeat(width - s.length - left);
}
