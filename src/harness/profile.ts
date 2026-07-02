/**
 * Harness profiles — the *execution* config, kept separate from the (frozen,
 * model-agnostic) standard_set. A profile is a feature-profile point: model,
 * reasoning/thinking effort, autonomy, a legacy capability list, and caps.
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
 * Fallback label for the host agent's model when nothing better is known. The
 * skill executes inside whatever agent invoked it, so floor and ceiling share
 * THE SAME model — the spread between them is effort/autonomy config, NOT a
 * model swap. True cross-model runs require a host that can spawn
 * alternative-model sub-agents (see profilesAreCrossModel) or the `--model`
 * flag on `exec-plan`.
 *
 * IMPORTANT: this is only a fallback. When a run is invoked through a CLI
 * harness (claude-code/codex), invoke.ts stamps the model the harness ACTUALLY
 * reported running and the report uses that ground truth instead of this
 * constant. Declared profile models are `null` (host-default) so a missing
 * stamp surfaces as "host-default" rather than a confidently wrong slug.
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
  /** Legacy capability list. Surface selection is controlled by the pack +
   *  `--surface`; profiles vary effort/model, not which interface is exposed. */
  surfaces: string[];
  maxTurns: number;
  /** Marks the attribution upper-bound column (the strongest configured run). */
  upperBound?: boolean;
}

/** The default effort sweep is named by EFFORT LEVEL — `low` vs `high` — so the
 *  knob being varied is explicit (the old `floor`/`ceiling` names are accepted
 *  as aliases for back-compat; see PROFILE_ALIASES). */
export const PROFILES: Record<string, HarnessProfile> = {
  low: {
    name: "low",
    // null = host-default: the report uses the model stamped from harness output
    // (ground truth). HOST_MODEL is only a last-resort label when nothing ran.
    model: null,
    effort: "low",
    autonomy: "auto",
    surfaces: ["docs", "api"],
    maxTurns: CONTROLLED_MAX_TURNS,
  },
  medium: {
    name: "medium",
    model: null,
    effort: "medium",
    autonomy: "auto",
    surfaces: ["docs", "api"],
    maxTurns: CONTROLLED_MAX_TURNS,
  },
  high: {
    name: "high",
    model: null,
    effort: "high",
    autonomy: "auto",
    surfaces: ["docs", "api"],
    maxTurns: CONTROLLED_MAX_TURNS,
    upperBound: true,
  },
  // Cross-model profiles (the matrix-mode set). Unlike low/high — which
  // share a model so EFFORT is the only variable — these vary the MODEL, so a
  // run mixing them with low/high is auto-labeled cross-model in the report
  // (profilesAreCrossModel). `model` is the human-readable label recorded in the
  // RunResult; spawn the matching sub-agent with the slug noted alongside.
  //
  // ⚠ Local CLI hosts (Claude Code, Codex, plain shells) cannot spawn child
  // agents on a different model — they're locked to the host's own model. Use
  // `--model` to pin the model a CLI harness runs as; the run records the model
  // the harness actually reported. Real cross-model data requires either that
  // `--model` (one run per model), Cursor Composer sub-agents, or a controlled
  // minimal harness that calls each model's API directly.
  sonnet: {
    name: "sonnet",
    model: "claude-4.6-sonnet", // spawn slug: claude-4.6-sonnet-medium-thinking
    effort: "high",
    autonomy: "auto",
    surfaces: ["docs", "api"],
    maxTurns: CONTROLLED_MAX_TURNS,
    upperBound: true,
  },
  gpt5: {
    name: "gpt5",
    model: "gpt-5.5", // spawn slug: gpt-5.5-medium
    effort: "high",
    autonomy: "auto",
    surfaces: ["docs", "api"],
    maxTurns: CONTROLLED_MAX_TURNS,
    upperBound: true,
  },
};

/** Back-compat: the effort profiles were once named floor/ceiling. Old commands,
 *  saved run files, and tests using those names still resolve to low/high. */
export const PROFILE_ALIASES: Record<string, string> = {
  floor: "low",
  ceiling: "high",
};

/** True only when the given profiles actually differ by model (matrix-mode
 *  cross-model). In the free tier they share HOST_MODEL, so the report must
 *  label the spread as config-only rather than a neutral cross-model score. */
export function profilesAreCrossModel(profiles: HarnessProfile[]): boolean {
  const models = new Set(profiles.map((p) => p.model ?? "host-default"));
  return models.size > 1;
}

export function getProfile(name: string): HarnessProfile {
  const resolved = PROFILE_ALIASES[name] ?? name;
  const p = PROFILES[resolved];
  if (!p) throw new Error(`unknown profile '${name}'; available: ${Object.keys(PROFILES).join(", ")} (aliases: ${Object.keys(PROFILE_ALIASES).join(", ")})`);
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
