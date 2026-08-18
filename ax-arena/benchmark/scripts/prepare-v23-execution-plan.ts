#!/usr/bin/env node
/**
 * Materialize the post-freeze V2.3 execution matrix without contacting a
 * provider. The resulting plan is vendor-first, hash-bound, and deliberately
 * includes structural N/A cells so a later result cannot erase them.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const suitePath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/vendor-experience-suite.yaml");
const outputPath = resolve(ROOT, process.env.DAEB_V23_EXECUTION_PLAN_OUT
  ?? "ax-arena/benchmark/axarena-database/v2-3/execution-plan.json");

type Task = { id: string; family: string; admitted_vendors: string[]; structural_na_vendors: string[] };
type Stratum = { model: string; provider: string };
type Suite = { schema: string; status: string; vendors: string[]; model_strata: Stratum[]; trial_count: number; tasks: Task[] };

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
const repoPath = (path: string) => relative(ROOT, path).split(sep).join("/");

function nativeContract(model: string): string {
  if (model === "google/gemini-3.7-flash-20260813") return "ax-arena/benchmark/axarena-database/v2-3/contracts/gemini-3.7-flash.yaml";
  if (model === "qwen/qwen3.8-27b-20260814") return "ax-arena/benchmark/axarena-database/v2-3/contracts/qwen-3.8-27b.yaml";
  if (model === "moonshotai/kimi-k3") return "ax-arena/benchmark/axarena-database/v2-3/contracts/kimi-k3.yaml";
  throw new Error(`no provider-pinned J01 contract for ${model}`);
}

const suite = parseYaml(readFileSync(suitePath, "utf8")) as Suite;
const cells = suite.vendors.flatMap((vendor) => suite.model_strata.flatMap((stratum) =>
  Array.from({ length: suite.trial_count }, (_, offset) => {
    const trial = offset + 1;
    return suite.tasks.map((task) => {
      const structuralNa = task.structural_na_vendors.includes(vendor);
      const command = task.id === "db-J01-native-journey"
        ? {
          script: "run-v22-native-pilot.ts",
          env: {
            DAEB_V22_CONTRACT: nativeContract(stratum.model),
            DAEB_V22_TRIAL: String(trial),
            DAEB_V22_VENDORS: vendor,
            DAEB_V22_RUN_ROOT: `results/v23-frozen/${vendor}/${stratum.model.replace(/[^a-z0-9]+/gi, "-")}/trial-${trial}/db-J01-native-journey`,
          },
        }
        : {
          script: "run-v21-gemini-differentiation.ts",
          env: {
            DAEB_V23_MODEL: stratum.model,
            DAEB_V23_PROVIDER: stratum.provider,
            DAEB_V23_PACK_ROOT: "ax-arena/benchmark/axarena-database/v2-3/packs",
            DAEB_V23_TRIAL: String(trial),
            DAEB_V23_VENDORS: vendor,
            DAEB_V23_EXEC_VENDORS: vendor,
            DAEB_V23_TASKS: task.id,
            DAEB_V23_RUN_ROOT: `results/v23-frozen/${vendor}/${stratum.model.replace(/[^a-z0-9]+/gi, "-")}/trial-${trial}/${task.id}`,
          },
        };
      return {
        cell_id: `${vendor}::${task.id}::${stratum.model}::t${trial}`,
        vendor,
        task_id: task.id,
        family: task.family,
        model: stratum.model,
        provider: stratum.provider,
        trial,
        status: structuralNa ? "structural-na" : "planned",
        ...(structuralNa ? { reason: "no independently auditable native verifier admitted" } : { command }),
      };
    });
  }).flat(),
)).flat();

const planned = {
  schema: "ax.daeb-v2-3-execution-plan/v1",
  suite: { path: repoPath(suitePath), sha256: sha256(suitePath), status: suite.status },
  formal: false,
  approval_gate: "Do not run as a benchmark record until freeze-review.json has explicit human approval for this exact suite hash.",
  primary_unit: "vendor",
  reporting_order: ["vendor", "task family", "model stratum", "trial"],
  counts: {
    total: cells.length,
    runnable: cells.filter((cell) => cell.status === "planned").length,
    structural_na: cells.filter((cell) => cell.status === "structural-na").length,
  },
  cells,
};
mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
writeFileSync(outputPath, JSON.stringify(planned, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ output_path: outputPath, counts: planned.counts, suite_sha256: planned.suite.sha256 }, null, 2));
