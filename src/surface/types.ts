/**
 * Surface primitives shared by every adapter. Kept in its own module (importing
 * only schemas) so the adapters can depend on it without creating a cycle with
 * the registry in index.ts (which imports the adapters).
 */
import type { TargetPack, Task } from "../schemas.js";

export type SurfaceId = "api" | "cli" | "sdk" | "mcp";

/** The canonical surface ordering (also the discovery → execution preference). */
export const SURFACE_IDS: readonly SurfaceId[] = ["api", "cli", "sdk", "mcp"];

/** Runtime guard for an untrusted surface string (CLI flag / executor self-report). */
export function isSurfaceId(value: unknown): value is SurfaceId {
  return typeof value === "string" && (SURFACE_IDS as readonly string[]).includes(value);
}

/** Shared Phase-0 header so every surface's discovery block reads consistently. */
export const DISCOVERY_HEADER = "=== PHASE 0 — DISCOVERY (cold start, scored) ===";

/** The product label an agent is told to operate (discovery.product or pack.name). */
export function productName(pack: TargetPack): string {
  return pack.discovery?.product || pack.name;
}

/** Concrete execution surfaces explicitly named on a task, excluding helper
 *  affordances like `docs`. Empty means the task bank hasn't been narrowed for
 *  execution surfaces yet, so the task applies everywhere. */
export function taskExecutionSurfaces(task: Pick<Task, "allowed_surfaces">): SurfaceId[] {
  return task.allowed_surfaces.filter(isSurfaceId);
}

/** Whether a task should run on the selected execution surface. */
export function taskSupportsSurface(task: Pick<Task, "allowed_surfaces">, surface: SurfaceId): boolean {
  const concrete = taskExecutionSurfaces(task);
  return concrete.length === 0 || concrete.includes(surface);
}

/** Subset of tasks that apply to the selected execution surface. */
export function tasksForSurface(pack: Pick<TargetPack, "tasks">, surface: SurfaceId): Task[] {
  return pack.tasks.filter((task) => taskSupportsSurface(task, surface));
}

/**
 * A surface adapter. The prompt builder composes these pieces; nothing here knows
 * about a specific task or oracle, so the same task bank runs across all surfaces.
 */
export interface Surface {
  id: SurfaceId;
  /** Subject noun used in the prompt intro (e.g. "API", "CLI"). */
  subject: string;
  /** Unit label for the per-run action budget (e.g. "API actions"). */
  actionUnit: string;
  /** Optional install/connect lines emitted BEFORE the discovery block. */
  setupBlock(pack: TargetPack): string[];
  /** The full Phase-0 discovery block (header line through the trailing blank). */
  discoveryBlock(pack: TargetPack): string[];
  /** The action-guidance sentence injected into the closing instructions. */
  actionGuidance(pack: TargetPack): string;
  /** Human hints for the (surface-independent) discovery result fields. The JSON
   *  KEYS stay constant (base_url_found / endpoint_used / auth_scheme_found) so
   *  the verifier + transcript parser are surface-agnostic; only the hint text
   *  changes per surface. */
  resultsHints: { base: string; endpoint: string; auth: string };
}
