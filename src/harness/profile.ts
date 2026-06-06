/**
 * Harness profiles — the *execution* config, kept separate from the (frozen,
 * model-agnostic) standard_set. A profile is a feature-profile point: model,
 * reasoning/thinking effort, autonomy, the surfaces it can use, and caps.
 *
 * Generation harness != execution harness. The bank declares only what a task
 * requires (allowed_surfaces, max_turns); a profile must SATISFY those. Each
 * RunResult records the full profile so a score is never confused with the
 * config that produced it (or with who authored the bank).
 *
 * Named profiles for the fan-out spread:
 *   floor   — deliberately weak baseline.
 *   ceiling — strongest available; doubles as the attribution upper bound
 *             ("even the best agent fails → it's the product/docs"). When the
 *             ceiling shares a model family with an L4 author, label it as a
 *             ceiling/control, not a neutral cross-agent score.
 */

/**
 * The model the host agent actually runs as. The skill executes inside the
 * current Cursor agent, so floor and ceiling share THIS model — the spread
 * between them is effort/autonomy config, NOT a model swap. True cross-model
 * runs require a host that can spawn alternative-model sub-agents (see
 * profilesAreCrossModel).
 */
export const HOST_MODEL = "composer-2.5";

/**
 * Controlled turn budget shared by every profile. maxTurns was previously a
 * hidden confound (floor=8 vs ceiling=25): a floor failure could be a turn
 * starvation artifact rather than a capability/effort signal. Holding it
 * constant makes EFFORT the single independent variable in the host-agent
 * fan-out, so the floor↔ceiling spread is attributable.
 *
 * Sized for the full run: Phase-0 discovery (several searches) + ~12 tasks, each
 * needing create/mutate calls. Kept generous so neither profile is turn-starved;
 * the floor still under-uses it by being low-effort, which is the signal.
 */
export const CONTROLLED_MAX_TURNS = 40;

/** Variables held constant across the host-agent fan-out (for the report). */
export const CONTROLLED_VARIABLES = ["model", "maxTurns", "task context/hints"] as const;
/** The single variable intentionally varied across profiles. */
export const VARIED_VARIABLE = "effort" as const;

export interface HarnessProfile {
  name: string;
  /** Model slug if the harness can switch; otherwise the host default. */
  model: string | null;
  /** Reasoning/thinking effort knob. */
  effort: "low" | "medium" | "high";
  /** Autonomy: does it just act, or ask/confirm. */
  autonomy: "auto" | "ask";
  /** Surfaces this profile is able to use. */
  surfaces: string[];
  maxTurns: number;
  /** Marks the attribution upper-bound column. */
  ceiling?: boolean;
}

export const PROFILES: Record<string, HarnessProfile> = {
  floor: {
    name: "floor",
    model: HOST_MODEL,
    effort: "low",
    autonomy: "auto",
    surfaces: ["docs", "api"],
    maxTurns: CONTROLLED_MAX_TURNS,
  },
  ceiling: {
    name: "ceiling",
    model: HOST_MODEL,
    effort: "high",
    autonomy: "auto",
    // Surfaces unused by REST-only Asana tasks; kept equal here so EFFORT is the
    // only knob that differs from floor.
    surfaces: ["docs", "api"],
    maxTurns: CONTROLLED_MAX_TURNS,
    ceiling: true,
  },
  // Cross-model profiles (the matrix-mode set). Unlike floor/ceiling — which
  // share HOST_MODEL so EFFORT is the only variable — these vary the MODEL, so a
  // run mixing them with floor/ceiling is auto-labeled cross-model in the report
  // (profilesAreCrossModel). `model` is the human-readable label recorded in the
  // RunResult; spawn the matching sub-agent with the slug noted alongside.
  //
  // ⚠ Local CLI hosts (Claude Code, Codex, plain shells) cannot spawn child
  // agents on a different model — they're locked to the host's own model. Using
  // these profiles there will record a `model` label that doesn't match what
  // actually ran, producing a misleading cross-model report. Real cross-model
  // data requires either:
  //   1. Cursor Composer, where the `Task` tool can spawn `claude-4.6-sonnet`
  //      / `gpt-5.5` sub-agents that genuinely run on those models, OR
  //   2. a controlled minimal harness that calls each model's API directly.
  // Plain CLI users should stick to `floor`/`ceiling` (effort-only spread).
  sonnet: {
    name: "sonnet",
    model: "claude-4.6-sonnet", // spawn slug: claude-4.6-sonnet-medium-thinking
    effort: "high",
    autonomy: "auto",
    surfaces: ["docs", "api"],
    maxTurns: CONTROLLED_MAX_TURNS,
    ceiling: true,
  },
  gpt5: {
    name: "gpt5",
    model: "gpt-5.5", // spawn slug: gpt-5.5-medium
    effort: "high",
    autonomy: "auto",
    surfaces: ["docs", "api"],
    maxTurns: CONTROLLED_MAX_TURNS,
    ceiling: true,
  },
};

/** True only when the given profiles actually differ by model (matrix-mode
 *  cross-model). In the free tier they share HOST_MODEL, so the report must
 *  label the spread as config-only rather than a neutral cross-model score. */
export function profilesAreCrossModel(profiles: HarnessProfile[]): boolean {
  const models = new Set(profiles.map((p) => p.model ?? "host-default"));
  return models.size > 1;
}

export function getProfile(name: string): HarnessProfile {
  const p = PROFILES[name];
  if (!p) throw new Error(`unknown profile '${name}'; available: ${Object.keys(PROFILES).join(", ")}`);
  return p;
}

/** A profile satisfies a task if it can use every surface the task allows. */
export function profileSatisfies(profile: HarnessProfile, allowedSurfaces: string[]): boolean {
  if (allowedSurfaces.length === 0) return true;
  return allowedSurfaces.every((s) => profile.surfaces.includes(s));
}

/** Stable label for a RunResult harness column. */
export function profileLabel(profile: HarnessProfile): string {
  const model = profile.model ?? "host-default";
  return `host-agent[${profile.name}:${model},effort=${profile.effort}]`;
}
