/**
 * Deterministic qualification witnesses for the V2.1-derived SQL tasks.
 * These are not model observations: each cell is a controller-owned setup,
 * mutation, independent read-back, cleanup, and hash-bound proof artifact.
 */
import "dotenv/config";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { makeV2Driver, proofForV2Task, runV2DeterministicTask } from "../src/authoring/database-v2-runner.js";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const VENDOR_PACKS: Record<string, string> = {
  cockroachdb: "ax-arena/benchmark/axarena-database/v2/production/packs/cockroachdb/pack.yaml",
  insforge: "ax-arena/benchmark/axarena-database/v2/production/packs/insforge/pack.yaml",
  neon: "ax-arena/benchmark/axarena-database/v2/production/packs/neon/pack.yaml",
  nile: "ax-arena/benchmark/axarena-database/v2/production/packs/nile/pack.yaml",
  turso: "ax-arena/benchmark/axarena-database/v2/production/packs/turso/pack.yaml",
  supabase: "ax-arena/benchmark/axarena-database/v2/production/extensions/supabase-cli/pack.yaml",
};
const TASKS = ["db-T18-constraint-preservation", "db-T19-transactional-record-recovery", "db-T20-aggregate-query", "db-T21-cli-principal-continuity", "db-T22-negative-query-verification"] as const;
const VENDORS = Object.keys(VENDOR_PACKS);
const runRoot = resolve(ROOT, process.env.DAEB_V21_DERIVED_WITNESS_ROOT ?? "results/daeb-v2-1-derived-witness-20260815");

function redacted(value: unknown): string {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/[^\s'"\)]+/gi, "<connection-redacted>")
    .replace(/https?:\/\/[^\s'"\)]+(?:token|key|secret|password)[^\s'"\)]*/gi, "<credential-url-redacted>");
}

function temporaryPack(sourcePath: string, taskId: string, outPath: string): void {
  const source = yamlParse(readFileSync(sourcePath, "utf8")) as { tasks?: Array<Record<string, unknown>> };
  const base = source.tasks?.find((task) => task.id === "db-T04-query-records");
  if (!base) throw new Error(`${sourcePath} has no db-T04-query-records source task`);
  const task = {
    ...base,
    id: taskId,
    title: taskId,
    prompt: `Qualification witness for ${taskId}; controller owns setup, mutation, read-back, and cleanup.`,
  };
  writeFileSync(outPath, yamlStringify({ ...source, tasks: [task] }) , { mode: 0o600 });
}

const cells: Array<Record<string, unknown>> = [];
mkdirSync(runRoot, { recursive: true, mode: 0o700 });
for (const vendor of VENDORS) {
  const sourcePath = resolve(ROOT, VENDOR_PACKS[vendor]!);
  const driver = makeV2Driver(vendor);
  for (const taskId of TASKS) {
    const cellDir = resolve(runRoot, "cells", vendor, taskId);
    mkdirSync(cellDir, { recursive: true, mode: 0o700 });
    if (driver.missingEnv.length) {
      const reason = `missing required CLI credential/context: ${driver.missingEnv.join(", ")}`;
      writeFileSync(resolve(cellDir, "blocked.json"), JSON.stringify({ status: "blocked", reason }, null, 2) + "\n", { mode: 0o600 });
      cells.push({ vendor, task_id: taskId, status: "blocked", reason, artifact_dir: `cells/${vendor}/${taskId}` });
      continue;
    }
    const ns = `v21_${taskId.replace(/^db-T\d+-/, "").replaceAll("-", "_")}_${vendor}_20260815`;
    try {
      const result = runV2DeterministicTask(driver, taskId, ns, cellDir);
      const proofPack = resolve(cellDir, "proof-pack.yaml");
      temporaryPack(sourcePath, taskId, proofPack);
      cells.push({
        vendor,
        task_id: taskId,
        status: result.ok ? "passed" : "failed",
        reason: result.reason,
        artifact_dir: `cells/${vendor}/${taskId}`,
        proof: result.ok ? proofForV2Task(proofPack, runRoot, cellDir, result.stages) : undefined,
      });
      console.log(`[v21-derived-witness] ${vendor}/${taskId}: ${result.ok ? "passed" : `failed — ${result.reason}`}`);
    } catch (error) {
      const reason = redacted(error);
      cells.push({ vendor, task_id: taskId, status: "failed", reason, artifact_dir: `cells/${vendor}/${taskId}` });
      console.log(`[v21-derived-witness] ${vendor}/${taskId}: failed — ${reason}`);
    }
  }
}

const manifest = {
  schema: "ax.daeb-v2-1-derived-sql-witness/v1",
  benchmark: "DAEB-2-CLI-V2.1-Harness-Neutral",
  generated_at: new Date().toISOString(),
  tasks: TASKS,
  vendors: VENDORS,
  run_root: runRoot,
  cells,
  summary: {
    passed: cells.filter((cell) => cell.status === "passed").length,
    failed: cells.filter((cell) => cell.status === "failed").length,
    blocked: cells.filter((cell) => cell.status === "blocked").length,
  },
};
writeFileSync(resolve(runRoot, "run-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
console.log(`[v21-derived-witness] manifest → ${resolve(runRoot, "run-manifest.json")}`);
if (manifest.summary.passed !== VENDORS.length * TASKS.length) process.exitCode = 1;
