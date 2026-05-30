/** Render a run as a human-readable matrix + failure summary (text/markdown). */
import type { RunReport } from "./runner.js";

export function render(report: RunReport): string {
  const harnesses = report.harnesses;
  const grid: Record<string, Record<string, boolean>> = {};
  for (const r of report.results) (grid[r.taskId] ??= {})[r.harness] = r.success;
  const taskIds = Object.keys(grid);

  const lines: string[] = [];
  const title = `AX eval — ${report.pack} v${report.packVersion}`;
  lines.push(title, "=".repeat(title.length), "");

  if (taskIds.length === 0) {
    lines.push("(no results)");
    return lines.join("\n");
  }

  // Matrix table.
  const tcol = Math.max(...taskIds.map((t) => t.length), "task".length);
  const header = "task".padEnd(tcol) + "  " + harnesses.map((h) => center(h, 10)).join("  ");
  lines.push(header, "-".repeat(header.length));
  for (const tid of taskIds) {
    const cells = harnesses.map((h) => center(grid[tid]![h] ? "PASS" : "FAIL", 10));
    lines.push(tid.padEnd(tcol) + "  " + cells.join("  "));
  }

  // Pass rates.
  lines.push("", "Pass rate by harness:");
  for (const h of harnesses) {
    const total = taskIds.filter((t) => h in grid[t]!).length;
    const passed = taskIds.filter((t) => grid[t]![h]).length;
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
