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

export interface HealthCheckSignals {
  /** Leftover probe resources suggest a prior trial did not clean up. */
  namespace_pollution_risk: boolean;
  /** Error text looks like rate-limit / quota exhaustion rather than empty scope. */
  quota_pressure_hint: boolean;
  leftover_candidates: number;
}

export interface HealthCheckResult extends ResetResult {
  kind: "health-check";
  signals: HealthCheckSignals;
}

/** Classify resetter listing/errors into actionable hygiene signals. */
export function classifyHealthCheckSignals(result: Pick<ResetResult, "candidates" | "errors" | "message">): HealthCheckSignals {
  const joined = [...result.errors, result.message ?? ""].join(" ").toLowerCase();
  return {
    namespace_pollution_risk: result.candidates > 0,
    quota_pressure_hint: /(quota|rate.?limit|too many requests|429|resource.?exhausted|billing)/i.test(joined),
    leftover_candidates: result.candidates,
  };
}

export async function healthCheckPack(
  pack: TargetPack,
  client: ResetClient,
  scope: Record<string, string>,
  opts: { reclaim?: boolean } = {},
): Promise<HealthCheckResult> {
  const result = await resetPack(pack, client, scope, { dryRun: !opts.reclaim });
  const signals = classifyHealthCheckSignals(result);
  const baseMessage = opts.reclaim
    ? `reclaimed ${result.deleted.length}/${result.candidates} probe resource(s) in sandbox scope`
    : `health-check: ${result.candidates} probe resource(s) present in sandbox scope`;
  const signalNotes = [
    signals.namespace_pollution_risk ? "namespace-pollution-risk" : null,
    signals.quota_pressure_hint ? "quota-pressure-hint" : null,
  ].filter(Boolean);
  return {
    ...result,
    kind: "health-check",
    signals,
    message: signalNotes.length ? `${baseMessage} [${signalNotes.join(", ")}]` : baseMessage,
  };
}
