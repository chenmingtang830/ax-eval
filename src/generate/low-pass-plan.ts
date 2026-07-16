import { posix } from "node:path";
import type { TargetPack } from "../schemas.js";
import { isSurfaceId, tasksForSurface, type SurfaceId } from "../surface/types.js";
import { assertArtifactSegment } from "./artifact-path.js";

export const LOW_PASS_PLAN_SCHEMA = "ax.low-pass-plan/v1" as const;

export interface LowPassPlanCell {
  id: string;
  vendor: string;
  surface: SurfaceId;
  harness: string;
  profile: "low";
  trial: 1;
  task_ids: string[];
  run_dir: string;
}

export interface LowPassExecutionPlan {
  schema: typeof LOW_PASS_PLAN_SCHEMA;
  suite: string;
  standard_set_version: string;
  vendor: string;
  generated_at: string;
  status: "ready" | "empty";
  execution_mode: "task";
  requested_surfaces: SurfaceId[];
  harnesses: string[];
  cells: LowPassPlanCell[];
  skipped_surfaces: Array<{ surface: SurfaceId; reason: "no-executable-tasks" }>;
}

function uniqueSegments(values: readonly string[], label: string): string[] {
  const validated = values.map((value) => assertArtifactSegment(value, label));
  if (new Set(validated).size !== validated.length) throw new Error(`${label} values must be unique`);
  return validated;
}

export function buildLowPassExecutionPlan(options: {
  suiteName: string;
  standardSetVersion: string;
  vendor: string;
  pack: Pick<TargetPack, "name" | "standard_set_version" | "tasks">;
  surfaces: readonly SurfaceId[];
  harnesses: readonly string[];
  now?: () => Date;
}): LowPassExecutionPlan {
  const suite = assertArtifactSegment(options.suiteName, "suite name");
  const standardSetVersion = assertArtifactSegment(options.standardSetVersion, "standard set version");
  const vendor = assertArtifactSegment(options.vendor, "vendor slug");
  const harnesses = uniqueSegments(options.harnesses, "harness");
  if (harnesses.length === 0) throw new Error("at least one low-pass harness is required");
  if (options.surfaces.length === 0) throw new Error("at least one low-pass surface is required");
  if (options.surfaces.some((surface) => !isSurfaceId(surface))) throw new Error("low-pass plan contains an invalid surface");
  if (new Set(options.surfaces).size !== options.surfaces.length) throw new Error("low-pass surfaces must be unique");

  const packVendor = options.pack.name.replace(/-generated$/, "");
  if (packVendor !== vendor) throw new Error(`low-pass vendor ${vendor} does not match pack ${packVendor}`);
  if (options.pack.standard_set_version !== standardSetVersion) {
    throw new Error(`low-pass standard set ${standardSetVersion} does not match pack ${options.pack.standard_set_version}`);
  }

  const cells: LowPassPlanCell[] = [];
  const skippedSurfaces: LowPassExecutionPlan["skipped_surfaces"] = [];
  for (const surface of options.surfaces) {
    const tasks = tasksForSurface(options.pack, surface);
    const taskIds = tasks.map((task) => task.id);
    const unverifiable = tasks.filter((task) => task.oracles.length === 0);
    if (unverifiable.length > 0) {
      throw new Error(`low-pass surface ${surface} contains executable tasks without oracles: ${unverifiable.map((task) => task.id).join(", ")}`);
    }
    if (new Set(taskIds).size !== taskIds.length) throw new Error(`low-pass surface ${surface} contains duplicate task ids`);
    if (taskIds.length === 0) {
      skippedSurfaces.push({ surface, reason: "no-executable-tasks" });
      continue;
    }
    for (const harness of harnesses) {
      cells.push({
        id: `${vendor}/${surface}/${harness}/trial-1`,
        vendor,
        surface,
        harness,
        profile: "low",
        trial: 1,
        task_ids: taskIds,
        run_dir: posix.join(vendor, surface, harness, "trial-1"),
      });
    }
  }

  return {
    schema: LOW_PASS_PLAN_SCHEMA,
    suite,
    standard_set_version: standardSetVersion,
    vendor,
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    status: cells.length > 0 ? "ready" : "empty",
    execution_mode: "task",
    requested_surfaces: [...options.surfaces],
    harnesses,
    cells,
    skipped_surfaces: skippedSurfaces,
  };
}
