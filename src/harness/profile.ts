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
 * New live evaluations use the single `medium` profile. Low/high and their
 * floor/ceiling aliases remain only so historical artifacts and explicit legacy
 * invocations can still be read and reproduced.
 */

/**
 * Fallback label for the host agent's model when nothing better is known. The
 * skill executes inside whatever agent invoked it. True cross-model runs require
 * a host that can spawn
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
 * Controlled turn budget shared by every profile. It remains fixed so an
 * explicit legacy effort override is never confounded with turn starvation.
 *
 * Sized for the full run: Phase-0 discovery (several searches) + ~12 tasks, each
 * needing create/mutate calls. It is kept generous for the standard medium run.
 */
export const CONTROLLED_MAX_TURNS = 40;

/** Variables held constant across a live evaluation (for the report). */
export const CONTROLLED_VARIABLES = ["model", "maxTurns", "task context/hints"] as const;
/** Legacy multi-effort artifacts may vary this field. */
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
  /** Marks the primary live-evaluation configuration. */
  upperBound?: boolean;
}

/** `medium` is the sole recommended profile for new evaluations. Low/high are
 * retained for reading historical runs and explicit backwards-compatible use. */
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
    upperBound: true,
  },
  high: {
    name: "high",
    model: null,
    effort: "high",
    autonomy: "auto",
    surfaces: ["docs", "api"],
    maxTurns: CONTROLLED_MAX_TURNS,
  },
  // Cross-model profiles (the optional matrix-mode set) vary the MODEL. `model`
  // is the human-readable label recorded in the
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
    model: "sonnet", // CLI alias; invoked runs stamp the exact reported model.
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

/** Back-compat: old commands, saved run files, and tests using floor/ceiling
 * still resolve to their historical low/high profiles. */
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
