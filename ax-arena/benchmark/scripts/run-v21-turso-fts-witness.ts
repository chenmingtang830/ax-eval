/** Qualification witness for the Turso CLI full-text-search tuple. */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { makeV2Driver, proofForV2Task, runV2DeterministicTask } from "../src/authoring/database-v2-runner.js";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SOURCE_TASK_ID = "db-T07-full-text-search";
const runRoot = resolve(ROOT, process.env.DAEB_V21_DERIVED_WITNESS_ROOT ?? "results/daeb-v2-1-derived-witness-20260815");
const candidateSuite = yamlParse(readFileSync(resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-1/candidate-suite-v2-1.yaml"), "utf8")) as { tasks?: Array<{ id?: string; skill?: string }> };
const TASK_ID = candidateSuite.tasks?.find((task) => task.skill === "full-text-search")?.id ?? "db-T13-full-text-search";
const cellDir = resolve(runRoot, "cells", "turso", TASK_ID);
const sourcePath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2/production/packs/turso/pack.yaml");
const proofPack = resolve(cellDir, "proof-pack.yaml");
mkdirSync(cellDir, { recursive: true, mode: 0o700 });
const source = yamlParse(readFileSync(sourcePath, "utf8")) as { tasks?: Array<Record<string, unknown>> };
const base = source.tasks?.find((task) => task.id === "db-T04-query-records");
if (!base) throw new Error("Turso source pack has no query task");
writeFileSync(proofPack, yamlStringify({ ...source, tasks: [{ ...base, id: TASK_ID, title: TASK_ID }] }), { mode: 0o600 });
const driver = makeV2Driver("turso");
const cells: Array<Record<string, unknown>> = [];
if (driver.missingEnv.length) {
  cells.push({ vendor: "turso", task_id: TASK_ID, status: "blocked", reason: `missing required CLI credential/context: ${driver.missingEnv.join(", ")}`, artifact_dir: `cells/turso/${TASK_ID}` });
} else {
  const ns = "v21_full_text_search_turso_20260815";
  const result = runV2DeterministicTask(driver, SOURCE_TASK_ID, ns, cellDir);
  cells.push({ vendor: "turso", task_id: TASK_ID, status: result.ok ? "passed" : "failed", reason: result.reason, artifact_dir: `cells/turso/${TASK_ID}`, proof: result.ok ? proofForV2Task(proofPack, runRoot, cellDir, result.stages) : undefined });
  console.log(`[v21-turso-fts-witness] ${result.ok ? "passed" : `failed — ${result.reason}`}`);
}
const manifestPath = resolve(runRoot, "run-manifest.json");
let existing: Record<string, unknown> = {};
try { existing = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>; } catch { /* first derived witness */ }
const prior = (Array.isArray(existing.cells) ? existing.cells as Array<Record<string, unknown>> : [])
  .filter((cell) => cell.task_id === "db-T18-constraint-preservation" || cell.task_id === "db-T19-transactional-record-recovery" || cell.task_id === "db-T20-aggregate-query" || cell.task_id === "db-T21-cli-principal-continuity" || cell.task_id === "db-T22-negative-query-verification" || cell.task_id === TASK_ID);
const cellsByKey = new Map([...prior, ...cells].map((cell) => [`${cell.vendor}/${cell.task_id}`, cell]));
const manifest = { schema: "ax.daeb-v2-1-derived-sql-witness/v1", benchmark: "DAEB-2-CLI-V2.1-Harness-Neutral", generated_at: new Date().toISOString(), tasks: ["db-T18-constraint-preservation", "db-T19-transactional-record-recovery", "db-T20-aggregate-query", "db-T21-cli-principal-continuity", "db-T22-negative-query-verification", TASK_ID], vendors: ["cockroachdb", "insforge", "neon", "nile", "turso", "supabase"], run_root: runRoot, cells: [...cellsByKey.values()], summary: { passed: [...cellsByKey.values()].filter((cell) => cell.status === "passed").length, failed: [...cellsByKey.values()].filter((cell) => cell.status === "failed").length, blocked: [...cellsByKey.values()].filter((cell) => cell.status === "blocked").length } };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
if (cells[0]?.status !== "passed") process.exitCode = 1;
