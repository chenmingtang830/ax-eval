/**
 * Pre-run health check: list (and optionally reclaim) probe resources left
 * behind in the pack's declared sandbox scope by earlier crashed or incomplete
 * runs. This is the hygiene gate that prevents cross-trial namespace pollution
 * and quota exhaustion in long benchmark lanes.
 *
 * The check is target-agnostic at the top level: it reuses the per-target
 * resetter's listing capability in dry-run mode, then optionally performs the
 * same deletion if `--reclaim` is set. Targets without a resetter degrade
 * gracefully (supported:false) rather than throwing.
 */
import type { TargetPack } from "../schemas.js";
import { resetPack, type ResetClient, type ResetResult } from "./reset.js";

export interface HealthCheckResult extends ResetResult {
  kind: "health-check";
}

export async function healthCheckPack(
  pack: TargetPack,
  client: ResetClient,
  scope: Record<string, string>,
  opts: { reclaim?: boolean } = {},
): Promise<HealthCheckResult> {
  const result = await resetPack(pack, client, scope, { dryRun: !opts.reclaim });
  return {
    ...result,
    kind: "health-check",
    message: opts.reclaim
      ? `reclaimed ${result.deleted.length}/${result.candidates} probe resource(s) in sandbox scope`
      : `health-check: ${result.candidates} probe resource(s) present in sandbox scope`,
  };
}
