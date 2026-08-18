import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";

export const V21_FAMILIES = [
  "access-auth-discovery",
  "schema-integrity",
  "query-search",
  "lifecycle-recovery",
] as const;
export type V21Family = (typeof V21_FAMILIES)[number];

export const V21_CHALLENGE_TAGS = [
  "multi-step-state",
  "constraint-preservation",
  "negative-verification",
  "recoverable-fault",
  "surface-ambiguity",
  "recovery",
] as const;
export type V21ChallengeTag = (typeof V21_CHALLENGE_TAGS)[number];

/** Source/evidence roots that must be hash-bound before a freeze can be
 * labelled production-eligible. Missing hashes are surfaced as null in the
 * manifest; they are never silently treated as passed gates. */
export const V21_FREEZE_GATE_KEYS = [
  "docs",
  "support",
  "oracle",
  "witness",
  "calibration",
  "review",
] as const;
export type V21FreezeGateKey = (typeof V21_FREEZE_GATE_KEYS)[number];

export const V21TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  difficulty: z.enum(["L1", "L2", "L3", "L4"]),
  skill: z.string().min(1).optional(),
  execution_family: z.enum(V21_FAMILIES),
  challenge_tags: z.array(z.enum(V21_CHALLENGE_TAGS)).min(1),
  discovery_reset: z.literal("family"),
  // Candidate suites intentionally retain low-coverage concepts so the
  // calibration ledger can show them as structural N/A and reject them
  // deterministically.  The production admission gate below (and the
  // freeze validator) enforces the >=5/6 vendor requirement for selected
  // tasks; requiring it here would make the 16-task candidate pool
  // impossible to audit end-to-end.
  supported_vendors: z.array(z.string().min(1)).min(1),
  task_fit_vendors: z.array(z.string().min(1)).optional(),
  anchor: z.boolean().default(false),
  intent: z.string().min(1),
  oracle_hint: z.string().min(1),
  allowed_surfaces: z.array(z.string()).optional(),
  na_examples: z.array(z.string()).optional(),
  rationale: z.string().optional(),
  controller_fixture_ref: z.string().min(1).optional(),
}).passthrough();
export type V21Task = z.infer<typeof V21TaskSchema>;

export const CalibrationObservationSchema = z.object({
  task_id: z.string().min(1),
  vendor: z.string().min(1),
  model: z.string().min(1),
  harness: z.enum(["pi", "opencode"]),
  trial: z.number().int().positive(),
  status: z.enum(["pass", "fail", "structural-na", "invalid-infra", "invalid-route"]),
  strict_pass: z.boolean().optional(),
  recovery_pass: z.boolean().optional(),
}).strict();
export type CalibrationObservation = z.infer<typeof CalibrationObservationSchema>;

export const V21SelectionPolicySchema = z.object({
  schema: z.literal("ax.daeb-v2-1-selection-policy/v1"),
  vendor_count: z.literal(6),
  target_task_count: z.literal(10),
  candidate_count: z.literal(16),
  anchor_task_ids: z.array(z.string()).length(3),
  family_counts: z.record(z.enum(V21_FAMILIES), z.number().int().positive()),
  difficulty_band_counts: z.object({
    low: z.literal(2),
    medium: z.literal(3),
    high: z.literal(2),
  }).strict(),
  calibration_models: z.array(z.string()).length(2),
  holdout_model: z.string().min(1),
  invalid_rate_max: z.number().min(0).max(1),
  pass_bands: z.object({
    low: z.tuple([z.number(), z.number()]),
    medium: z.tuple([z.number(), z.number()]),
    high: z.tuple([z.number(), z.number()]),
  }).strict(),
}).strict();
export type V21SelectionPolicy = z.infer<typeof V21SelectionPolicySchema>;

export const DEFAULT_V21_SELECTION_POLICY: V21SelectionPolicy = {
  schema: "ax.daeb-v2-1-selection-policy/v1",
  vendor_count: 6,
  target_task_count: 10,
  candidate_count: 16,
  anchor_task_ids: ["db-T02-evolve-schema", "db-T04-query-records", "db-T06-write-records"],
  family_counts: {
    "access-auth-discovery": 2,
    "schema-integrity": 3,
    "query-search": 3,
    "lifecycle-recovery": 2,
  },
  difficulty_band_counts: { low: 2, medium: 3, high: 2 },
  calibration_models: ["google/gemini-3.7-flash-20260813", "deepseek/deepseek-v4-flash-20260731"],
  holdout_model: "z-ai/glm-5.2-20260616",
  invalid_rate_max: 0.05,
  pass_bands: { low: [0.25, 0.5], medium: [0.5, 0.75], high: [0.75, 0.9] },
};

export interface V21TaskSelection {
  task: V21Task;
  selected: boolean;
  reason: string;
  calibration_pass_rate: number | null;
  invalid_rate: number | null;
  model_spread: number | null;
  strict_recovery_dispersion: number | null;
}

export interface V21SelectionResult {
  schema: "ax.daeb-v2-1-selection-result/v1";
  policy: V21SelectionPolicy;
  selected: V21Task[];
  ledger: V21TaskSelection[];
  calibration_observations: number;
  candidate_count: number;
  selection_hash: string;
  source_hashes?: Record<string, string>;
}

function rate(values: CalibrationObservation[], predicate: (item: CalibrationObservation) => boolean): number {
  return values.length ? values.filter(predicate).length / values.length : 0;
}

function scoreTask(task: V21Task, observations: CalibrationObservation[], policy: V21SelectionPolicy): V21TaskSelection {
  // Selection is driven only by the registered Pi calibration lane. The GLM
  // holdout is retained in the input evidence but must not change admission.
  const calibrationModels = new Set(policy.calibration_models);
  const calibration = observations.filter((item) => calibrationModels.has(item.model));
  const valid = calibration.filter((item) => item.status === "pass" || item.status === "fail");
  const passed = rate(valid, (item) => item.status === "pass");
  // Structural N/A is not an infrastructure defect. Route/transport defects
  // are, and remain visible in the raw calibration JSONL.
  const invalid = calibration.length
    ? calibration.filter((item) => item.status === "invalid-infra" || item.status === "invalid-route").length / calibration.length
    : 1;
  const models = [...new Set(valid.map((item) => item.model))];
  const modelRates = models.map((model) => rate(valid.filter((item) => item.model === model), (item) => item.status === "pass"));
  const modelSpread = modelRates.length > 1 ? Math.max(...modelRates) - Math.min(...modelRates) : 0;
  const process = valid.flatMap((item) => [item.strict_pass, item.recovery_pass].filter((value): value is boolean => value !== undefined));
  const processRate = process.length ? process.filter(Boolean).length / process.length : 0;
  const strictRecoveryDispersion = process.length ? Math.abs(passed - processRate) : 0;
  return {
    task,
    selected: false,
    reason: "",
    calibration_pass_rate: valid.length ? passed : null,
    invalid_rate: observations.length ? invalid : null,
    model_spread: models.length > 1 ? modelSpread : null,
    strict_recovery_dispersion: process.length ? strictRecoveryDispersion : null,
  };
}

function inBand(value: number | null, band: readonly [number, number]): boolean {
  return value !== null && value >= band[0] && value < band[1];
}

function difficultyBand(value: number | null, policy: V21SelectionPolicy): "low" | "medium" | "high" | null {
  if (inBand(value, policy.pass_bands.low)) return "low";
  if (inBand(value, policy.pass_bands.medium)) return "medium";
  if (inBand(value, policy.pass_bands.high)) return "high";
  return null;
}

function combinations<T>(items: readonly T[], count: number): T[][] {
  if (count === 0) return [[]];
  if (items.length < count) return [];
  const output: T[][] = [];
  const visit = (start: number, chosen: T[]) => {
    if (chosen.length === count) {
      output.push([...chosen]);
      return;
    }
    for (let index = start; index <= items.length - (count - chosen.length); index += 1) {
      chosen.push(items[index]!);
      visit(index + 1, chosen);
      chosen.pop();
    }
  };
  visit(0, []);
  return output;
}

/**
 * Deterministic V2.1 candidate selector. Anchors are unconditional; new tasks
 * must satisfy the calibration bands, five-of-six vendor coverage, and invalid-rate
 * gate. Ties are broken by model spread, then strict/recovery dispersion, then
 * stable task id so a freeze is reproducible.
 */
export function selectV21Tasks(
  candidates: readonly V21Task[],
  observations: readonly CalibrationObservation[],
  policy: V21SelectionPolicy = DEFAULT_V21_SELECTION_POLICY,
): V21SelectionResult {
  const parsedPolicy = V21SelectionPolicySchema.parse(policy);
  if (candidates.length !== parsedPolicy.candidate_count) {
    throw new Error(`V2.1 selection requires exactly ${parsedPolicy.candidate_count} candidates, got ${candidates.length}`);
  }
  const tasks = candidates.map((task) => V21TaskSchema.parse(task));
  const candidateIds = new Set(tasks.map((task) => task.id));
  if (candidateIds.size !== tasks.length) throw new Error("V2.1 candidate suite contains duplicate task ids");
  for (const anchor of parsedPolicy.anchor_task_ids) {
    if (!candidateIds.has(anchor)) throw new Error(`V2.1 candidate suite is missing historical anchor ${anchor}`);
  }
  const obs = observations.map((item) => CalibrationObservationSchema.parse(item));
  const allowedModels = new Set([...parsedPolicy.calibration_models, parsedPolicy.holdout_model]);
  for (const item of obs) {
    if (item.harness !== "pi" || item.trial !== 1) {
      throw new Error("V2.1 calibration evidence must use Pi and exactly trial 1");
    }
    if (!allowedModels.has(item.model)) {
      throw new Error(`V2.1 calibration evidence contains an unregistered model: ${item.model}`);
    }
  }
  for (const task of tasks) {
    if (parsedPolicy.anchor_task_ids.includes(task.id)) continue;
    const taskObs = obs.filter((item) => item.task_id === task.id);
    const missing = [...parsedPolicy.calibration_models, parsedPolicy.holdout_model]
      .filter((model) => !taskObs.some((item) => item.model === model));
    if (missing.length) {
      throw new Error(`V2.1 calibration evidence is missing ${task.id} model(s): ${missing.join(", ")}`);
    }
  }
  const byTask = new Map<string, CalibrationObservation[]>();
  for (const item of obs) byTask.set(item.task_id, [...(byTask.get(item.task_id) ?? []), item]);
  const ledger = tasks.map((task) => scoreTask(task, byTask.get(task.id) ?? [], parsedPolicy));
  const anchors = new Set(parsedPolicy.anchor_task_ids);
  const selected: V21Task[] = [];
  for (const entry of ledger) {
    if (anchors.has(entry.task.id)) {
      entry.selected = true;
      entry.reason = "historical anchor";
      selected.push(entry.task);
    }
  }
  const familyNeeds = new Map<V21Family, number>();
  const eligibleByFamily = new Map<V21Family, V21TaskSelection[]>();
  const taskFitVendorCount = (task: V21Task) => (task.task_fit_vendors ?? task.supported_vendors).length;
  for (const family of V21_FAMILIES) {
    const target = parsedPolicy.family_counts[family];
    if (target === undefined) throw new Error(`V2.1 policy is missing family quota for ${family}`);
    const have = selected.filter((task) => task.execution_family === family).length;
    const needed = target - have;
    if (needed < 0) throw new Error(`anchors exceed V2.1 family quota for ${family}`);
    const pool = ledger
      .filter((entry) => !entry.selected && entry.task.execution_family === family)
      .filter((entry) => taskFitVendorCount(entry.task) >= parsedPolicy.vendor_count - 1)
      .filter((entry) => (entry.invalid_rate ?? 1) <= parsedPolicy.invalid_rate_max)
      .filter((entry) => difficultyBand(entry.calibration_pass_rate, parsedPolicy) !== null)
      .sort((left, right) => {
        const spread = (right.model_spread ?? -1) - (left.model_spread ?? -1);
        if (spread) return spread;
        const process = (right.strict_recovery_dispersion ?? -1) - (left.strict_recovery_dispersion ?? -1);
        return process || left.task.id.localeCompare(right.task.id);
      });
    // Fail with an actionable authoring diagnosis before the backtracking
    // search.  This matters for V2.1 because family quotas are contractual:
    // an apparently valid 16-task candidate can still be mathematically
    // incapable of producing the requested 10-task suite (for example, only
    // one access-family task may have >=5/6 vendor coverage).  Do not let that
    // surface later as a generic "difficulty-band" failure.
    if (pool.length < needed) {
      const coverage = ledger
        .filter((entry) => !entry.selected && entry.task.execution_family === family)
        .filter((entry) => taskFitVendorCount(entry.task) >= parsedPolicy.vendor_count - 1)
        .map((entry) => `${entry.task.id}:${taskFitVendorCount(entry.task)}/6`)
        .join(", ");
      throw new Error(
        `V2.1 selection is unsatisfiable for ${family}: need ${needed} calibrated task(s), `
        + `but only ${pool.length} candidate(s) meet >=5/6 coverage, invalid-rate, and calibration-band gates `
        + (coverage ? `(coverage candidates: ${coverage})` : "(no coverage candidates)"),
      );
    }
    familyNeeds.set(family, needed);
    eligibleByFamily.set(family, pool);
  }
  const bandCounts = { low: 0, medium: 0, high: 0 };
  const familyChoices: Partial<Record<V21Family, V21TaskSelection[]>> = {};
  const search = (familyIndex: number): boolean => {
    if (familyIndex === V21_FAMILIES.length) {
      return bandCounts.low === parsedPolicy.difficulty_band_counts.low
        && bandCounts.medium === parsedPolicy.difficulty_band_counts.medium
        && bandCounts.high === parsedPolicy.difficulty_band_counts.high;
    }
    const family = V21_FAMILIES[familyIndex]!;
    const needed = familyNeeds.get(family)!;
    const pool = eligibleByFamily.get(family)!;
    for (const choice of combinations(pool, needed)) {
      const local = { low: 0, medium: 0, high: 0 };
      for (const entry of choice) {
        const band = difficultyBand(entry.calibration_pass_rate, parsedPolicy)!;
        local[band] += 1;
      }
      if (bandCounts.low + local.low > parsedPolicy.difficulty_band_counts.low
        || bandCounts.medium + local.medium > parsedPolicy.difficulty_band_counts.medium
        || bandCounts.high + local.high > parsedPolicy.difficulty_band_counts.high) continue;
      bandCounts.low += local.low;
      bandCounts.medium += local.medium;
      bandCounts.high += local.high;
      familyChoices[family] = choice;
      if (search(familyIndex + 1)) return true;
      bandCounts.low -= local.low;
      bandCounts.medium -= local.medium;
      bandCounts.high -= local.high;
      delete familyChoices[family];
    }
    return false;
  };
  if (!search(0)) throw new Error("V2.1 calibration cannot satisfy exact difficulty-band quotas");
  for (const family of V21_FAMILIES) {
    for (const entry of familyChoices[family] ?? []) {
      entry.selected = true;
      entry.reason = "calibrated discrimination candidate";
      selected.push(entry.task);
    }
  }
  if (selected.length !== parsedPolicy.target_task_count) {
    throw new Error(`V2.1 selection produced ${selected.length} tasks, expected ${parsedPolicy.target_task_count}`);
  }
  const canonical = JSON.stringify({ policy: parsedPolicy, selected: selected.map((task) => task.id), ledger });
  return {
    schema: "ax.daeb-v2-1-selection-result/v1",
    policy: parsedPolicy,
    selected,
    ledger,
    calibration_observations: obs.length,
    candidate_count: candidates.length,
    selection_hash: createHash("sha256").update(canonical).digest("hex"),
  };
}

export function validateV21FreezeSelection(result: V21SelectionResult): void {
  const parsed = V21SelectionResultSchema.parse(result);
  if (parsed.selected.length !== parsed.policy.target_task_count) throw new Error("V2.1 freeze has wrong task count");
  const ids = new Set(parsed.selected.map((task) => task.id));
  for (const anchor of parsed.policy.anchor_task_ids) if (!ids.has(anchor)) throw new Error(`V2.1 freeze is missing anchor ${anchor}`);
  for (const family of V21_FAMILIES) {
    const count = parsed.selected.filter((task) => task.execution_family === family).length;
    if (count !== parsed.policy.family_counts[family]) throw new Error(`V2.1 freeze has wrong ${family} quota`);
  }
  for (const task of parsed.selected) {
    if (!parsed.policy.anchor_task_ids.includes(task.id) && task.challenge_tags.length < 2) {
      throw new Error(`V2.1 freeze task ${task.id} needs at least two challenge tags`);
    }
    const taskFitVendors = task.task_fit_vendors ?? task.supported_vendors;
    if (!taskFitVendors.length || taskFitVendors.length < 5) {
      throw new Error(`V2.1 freeze task ${task.id} has fewer than five supported vendors`);
    }
    if (!(task.allowed_surfaces ?? ["cli"]).includes("cli")) {
      throw new Error(`V2.1 freeze task ${task.id} is not admitted on CLI`);
    }
  }
  const selectedIds = new Set(parsed.selected.map((task) => task.id));
  const bands = { low: 0, medium: 0, high: 0 };
  for (const entry of parsed.ledger) {
    if (!entry.selected || !selectedIds.has(entry.task.id) || parsed.policy.anchor_task_ids.includes(entry.task.id)) continue;
    const band = difficultyBand(entry.calibration_pass_rate, parsed.policy);
    if (band) bands[band] += 1;
  }
  if (bands.low !== parsed.policy.difficulty_band_counts.low
    || bands.medium !== parsed.policy.difficulty_band_counts.medium
    || bands.high !== parsed.policy.difficulty_band_counts.high) {
    throw new Error("V2.1 freeze has wrong difficulty-band quotas");
  }
}

export const V21SelectionResultSchema = z.object({
  schema: z.literal("ax.daeb-v2-1-selection-result/v1"),
  policy: V21SelectionPolicySchema,
  selected: z.array(V21TaskSchema),
  ledger: z.array(z.object({
    task: V21TaskSchema,
    selected: z.boolean(),
    reason: z.string(),
    calibration_pass_rate: z.number().nullable(),
    invalid_rate: z.number().nullable(),
    model_spread: z.number().nullable(),
    strict_recovery_dispersion: z.number().nullable(),
  }).strict()),
  calibration_observations: z.number().int().nonnegative(),
  candidate_count: z.number().int().positive(),
  selection_hash: z.string().regex(/^[a-f0-9]{64}$/),
  source_hashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
}).strict();

export function freezeV21Suite(result: V21SelectionResult, sourceHashes: Record<string, string>): { yaml: string; manifest: Record<string, unknown> } {
  validateV21FreezeSelection(result);
  const allSourceHashes = { ...(result.source_hashes ?? {}), ...sourceHashes };
  const gateSource = (key: V21FreezeGateKey): string | undefined => key === "calibration"
    ? allSourceHashes.calibration ?? allSourceHashes.calibration_results
    : allSourceHashes[key];
  const gateHashes = Object.fromEntries(V21_FREEZE_GATE_KEYS.map((key) => [key, gateSource(key) ?? null]));
  const gatesComplete = V21_FREEZE_GATE_KEYS.every((key) => {
    const value = gateSource(key);
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  });
  const controllerFixturePlan = Object.fromEntries(result.selected.map((task) => [task.id, {
    controller_fixture_ref: task.controller_fixture_ref ?? `database/${task.skill ?? task.id}`,
    discovery_reset: task.discovery_reset,
    exact_scope_cleanup: true,
  }]));
  const manifest = {
    schema: "ax.daeb-v2-1-freeze-manifest/v1",
    suite_version: "2.1",
    selection_hash: result.selection_hash,
    source_hashes: allSourceHashes,
    freeze_gates: gateHashes,
    production_eligible: gatesComplete,
    policy: result.policy,
    selected_task_ids: result.selected.map((task) => task.id),
    controller_fixture_plan: controllerFixturePlan,
    immutable: true,
  };
  return {
    yaml: yamlStringify({
      name: "DAEB-2-CLI-V2.1-Harness-Neutral",
      version: 21,
      category: "database",
      description: "Frozen six-vendor CLI suite with family-isolated cold-start sessions.",
      tasks: result.selected.map((task) => {
        const { controller_fixture_ref: _controllerFixtureRef, ...agentTask } = task;
        return {
          ...agentTask,
          skill: task.skill ?? "v21-" + task.id,
          // V2.1 is explicitly a CLI-only lane. Keep the candidate's broader
          // surface notes in the selection artifact, but never admit API/SDK
          // execution into the frozen agent-visible pack.
          allowed_surfaces: ["cli"],
          na_examples: task.na_examples ?? [],
          supported_vendors: task.supported_vendors,
          anchor: task.anchor ?? result.policy.anchor_task_ids.includes(task.id),
          // controller_fixture_ref is deliberately kept only in the freeze
          // sidecar above; it is not agent-visible pack content.
        };
      }),
      scoring: {
        per_task: "pass | fail | structural-na | invalid-infra | invalid-route",
        discovery_reset: "family",
        primary_metric: "provider-oracle task usability",
      },
    }),
    manifest,
  };
}

export function readCalibrationJsonl(path: string): CalibrationObservation[] {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return CalibrationObservationSchema.parse(JSON.parse(line)); }
    catch (error) { throw new Error(`invalid calibration JSONL line ${index + 1}: ${String(error)}`); }
  });
}
