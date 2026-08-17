/**
 * Independent deterministic witness for the V2.1 CLI-session-discovery task.
 *
 * This is a qualification artifact, not model evidence. It creates one
 * namespace-scoped relation, records the authenticated SQL principal, reads it
 * back through the same declared CLI data plane, and drops the relation in the
 * task runner's explicit cleanup stage.
 */
import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeV2Driver, proofForV2Task, runV2DeterministicTask } from "../src/authoring/database-v2-runner.js";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const VENDOR_PACKS: Record<string, string> = {
  cockroachdb: "ax-arena/benchmark/axarena-database/v2/production/packs/cockroachdb/pack.yaml",
  insforge: "ax-arena/benchmark/axarena-database/v2/production/packs/insforge/pack.yaml",
  neon: "ax-arena/benchmark/axarena-database/v2/production/packs/neon/pack.yaml",
  nile: "ax-arena/benchmark/axarena-database/v2/production/packs/nile/pack.yaml",
  supabase: "ax-arena/benchmark/axarena-database/v2/production/extensions/supabase-cli/pack.yaml",
};
const VENDORS = Object.keys(VENDOR_PACKS);
const TASK_ID = "db-T17-cli-session-discovery";
const runRoot = resolve(ROOT, process.env.DAEB_V21_SESSION_WITNESS_ROOT ?? "results/daeb-v2-1-cli-session-witness-20260815");

function redactedError(value: unknown): string {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/[^\s'"\)]+/gi, "<connection-redacted>")
    .replace(/https?:\/\/[^\s'"\)]+(?:token|key|secret|password)[^\s'"\)]*/gi, "<credential-url-redacted>");
}

const cells: Array<Record<string, unknown>> = [];
mkdirSync(runRoot, { recursive: true, mode: 0o700 });
for (const vendor of VENDORS) {
  const packPath = resolve(ROOT, VENDOR_PACKS[vendor]!);
  const cellDir = resolve(runRoot, "cells", vendor, TASK_ID);
  mkdirSync(cellDir, { recursive: true, mode: 0o700 });
  const driver = makeV2Driver(vendor);
  if (driver.missingEnv.length) {
    const reason = `missing required CLI credential/context: ${driver.missingEnv.join(", ")}`;
    writeFileSync(resolve(cellDir, "blocked.json"), JSON.stringify({ status: "blocked", reason }, null, 2) + "\n", { mode: 0o600 });
    cells.push({ vendor, task_id: TASK_ID, status: "blocked", reason, artifact_dir: `cells/${vendor}/${TASK_ID}` });
    continue;
  }
  const ns = `v21_session_${vendor}_20260815`;
  try {
    const result = runV2DeterministicTask(driver, TASK_ID, ns, cellDir);
    cells.push({
      vendor,
      task_id: TASK_ID,
      status: result.ok ? "passed" : "failed",
      reason: result.reason,
      artifact_dir: `cells/${vendor}/${TASK_ID}`,
      proof: result.ok ? proofForV2Task(packPath, runRoot, cellDir, result.stages) : undefined,
    });
    console.log(`[v21-session-witness] ${vendor}: ${result.ok ? "passed" : `failed — ${result.reason}`}`);
  } catch (error) {
    const reason = redactedError(error);
    cells.push({ vendor, task_id: TASK_ID, status: "failed", reason, artifact_dir: `cells/${vendor}/${TASK_ID}` });
    console.log(`[v21-session-witness] ${vendor}: failed — ${reason}`);
  }
}

const manifest = {
  schema: "ax.daeb-v2-1-cli-session-witness/v1",
  benchmark: "DAEB-2-CLI-V2.1-Harness-Neutral",
  generated_at: new Date().toISOString(),
  task_id: TASK_ID,
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
console.log(`[v21-session-witness] manifest → ${resolve(runRoot, "run-manifest.json")}`);
if (manifest.summary.passed !== VENDORS.length) process.exitCode = 1;
