/** The runner: orchestrate N tasks × M harnesses into a result set + matrix. */
import { getHarness } from "./adapters/registry.js";
import type { RunResult, TargetPack } from "./schemas.js";

export interface RunReport {
  pack: string;
  packVersion: string;
  harnesses: string[];
  /** Subset of `harnesses` that are synthetic controls (e.g. a perfect mock).
   *  Excluded from the static×behavioral gap so a by-construction ceiling can't
   *  erase it. */
  synthetic: string[];
  results: RunResult[];
}

export interface RunOptions {
  progress?: boolean;
}

/** Run every task in `pack` across each named harness, sequentially. */
export async function run(
  pack: TargetPack,
  harnessNames: string[],
  opts: RunOptions = {},
): Promise<RunReport> {
  const results: RunResult[] = [];
  const synthetic: string[] = [];
  for (const name of harnessNames) {
    const harness = getHarness(name);
    if (harness.synthetic) synthetic.push(name);
    for (const task of pack.tasks) {
      const result = await harness.run(task, pack);
      results.push(result);
      if (opts.progress) {
        const mark = result.success ? "PASS" : "FAIL";
        console.log(`  [${mark}] ${name} × ${task.id}`);
      }
    }
  }
  return { pack: pack.name, packVersion: pack.version, harnesses: [...harnessNames], synthetic, results };
}

/** task_id → { harness → success }. */
export function matrix(report: RunReport): Record<string, Record<string, boolean>> {
  const grid: Record<string, Record<string, boolean>> = {};
  for (const r of report.results) {
    (grid[r.taskId] ??= {})[r.harness] = r.success;
  }
  return grid;
}

export function passRate(report: RunReport, harness: string): number {
  const rs = report.results.filter((r) => r.harness === harness);
  return rs.length ? rs.filter((r) => r.success).length / rs.length : 0;
}
