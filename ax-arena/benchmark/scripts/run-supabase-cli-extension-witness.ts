import "dotenv/config";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import {
  makeV2Driver,
  proofForV2Task,
  runV2DeterministicTask,
  type V2StageRecord,
} from "../src/authoring/database-v2-runner.js";

const repo = resolve(new URL("../../..", import.meta.url).pathname);
const packPath = resolve(repo, "ax-arena/benchmark/axarena-database/v2/production/extensions/supabase-cli/pack.yaml");
const runRoot = resolve(repo, process.env.DAEB_SUPABASE_WITNESS_ROOT ?? "results/daeb-v2-supabase-cli-extension-witness-20260814");
const pack = parse(readFileSync(packPath, "utf8")) as { tasks: Array<{ id: string; na?: boolean }> };
const driver = makeV2Driver("supabase");
const cells: Array<Record<string, unknown>> = [];

mkdirSync(runRoot, { recursive: true, mode: 0o700 });
for (const [index, task] of pack.tasks.entries()) {
  if (task.na) continue;
  const taskDir = resolve(runRoot, "cells", task.id);
  mkdirSync(taskDir, { recursive: true, mode: 0o700 });
  const namespace = `d2x-supa-t${index + 1}-wit`;
  const result = runV2DeterministicTask(driver, task.id, namespace, taskDir);
  const stageNames = ["setup", "mutation", "verify", "cleanup"] as const;
  const stages = Object.fromEntries(stageNames.map((name) => [
    name,
    JSON.parse(readFileSync(resolve(taskDir, `${name}.json`), "utf8")) as V2StageRecord,
  ])) as Record<string, V2StageRecord>;
  const proof = result.ok ? proofForV2Task(packPath, runRoot, taskDir, stages) : undefined;
  cells.push({
    vendor: "supabase",
    task_id: task.id,
    surface: "cli",
    status: result.ok ? "passed" : "failed",
    reason: result.reason,
    artifact_dir: taskDir.replace(`${runRoot}/`, ""),
    ...(proof ? { proof } : {}),
  });
  console.log(`[supabase-witness] ${task.id}: ${result.ok ? "passed" : `failed — ${result.reason}`}`);
}

const manifest = {
  schema: "ax.daeb-v2-cli-extension-witness-run/v1",
  benchmark: "DAEB-2",
  extension: "supabase-cli",
  generated_at: new Date().toISOString(),
  source_pack: packPath,
  run_root: runRoot,
  cells,
};
writeFileSync(resolve(runRoot, "run-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });

const passed = cells.filter((cell) => cell.status === "passed").length;
const support = {
  schema: "ax.daeb-v2-cli-extension-support/v1",
  benchmark: "DAEB-2",
  extension: "supabase-cli",
  surface: "cli",
  source_pack: "production/extensions/supabase-cli/pack.yaml",
  generated_at: manifest.generated_at,
  entries: cells.map((cell) => ({
    vendor: "supabase",
    task_id: cell.task_id,
    surface: "cli",
    status: cell.status === "passed" ? "supported" : "inconclusive",
    reason: cell.status === "passed"
      ? "deterministic CLI witness passed setup, mutation, independent read-back, cleanup, and hash binding"
      : String(cell.reason || "deterministic CLI witness failed; tuple is not admitted"),
    witness_required: false,
  })),
};
writeFileSync(resolve(runRoot, "support-matrix.yaml"), stringify(support), { mode: 0o600 });
console.log(`[supabase-witness] summary: ${passed}/${cells.length} passed`);
