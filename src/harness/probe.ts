/**
 * Harness probe — make AX Eval self-aware of the host it executes inside.
 *
 * AX Eval ships as a SKILL run inside someone else's agent harness (Cursor,
 * Claude Code, OpenAI Codex, a generic CI runner, …). The probe inspects cheap,
 * non-network signals (env vars + the Node runtime) to (1) stamp provenance on
 * every run for reproducibility, and (2) suggest the execution profile that best
 * fits the detected host instead of assuming a fixed model.
 *
 * Detection is pure/deterministic given an env object so it's unit-testable, and
 * it NEVER throws — an unrecognized host falls back to `unknown`/host-default.
 * Only env-var KEY NAMES are recorded as provenance, never their (secret) values.
 */
import { HOST_MODEL, getProfile, profilesAreCrossModel } from "./profile.js";

export type HarnessHost = "cursor" | "claude-code" | "codex" | "ci" | "unknown";

/** The profile(s) recommended for the detected host. */
export interface ProfileSuggestion {
  /** Profile names from PROFILES to run on this host. */
  profiles: string[];
  /** True when the suggested profiles span models (a cross-model run). */
  matrix: boolean;
  /** Why these profiles were chosen. */
  reason: string;
}

/** Best-effort identity + provenance of the host harness this process runs in. */
export interface HarnessProbe {
  /** Detected host harness, or "unknown" when no signal matched. */
  host: HarnessHost;
  /** Human-readable host label. */
  hostLabel: string;
  /** Detected/declared model slug, or null when not discoverable. */
  model: string | null;
  /** Detection confidence: high (host-specific marker), low (generic marker), none. */
  confidence: "high" | "low" | "none";
  /** Node runtime version (process.version). */
  node: string;
  /** OS platform (process.platform). */
  platform: string;
  /** CPU architecture (process.arch). */
  arch: string;
  /** UTC ISO timestamp the probe ran. */
  detectedAt: string;
  /** Env-var KEY NAMES present that contributed to detection (no values). */
  signals: string[];
  /** Profile recommendation for this host. */
  suggestion: ProfileSuggestion;
}

/**
 * One host detection rule. `strong` markers give high confidence; `weak` markers
 * (e.g. a bare API key) give low confidence. Entries ending in `_` match by
 * prefix; otherwise they match an exact key. Rules are evaluated most-specific
 * first so an agent host wins over a generic CI signal.
 */
interface HostRule {
  host: Exclude<HarnessHost, "unknown">;
  hostLabel: string;
  strong: string[];
  weak: string[];
  /** Env keys that may carry an explicitly declared model slug. */
  modelEnv: string[];
  /** Model assumed for this host when none is declared in env. */
  defaultModel: string | null;
  profiles: string[];
  reason: string;
}

const RULES: HostRule[] = [
  {
    host: "cursor",
    hostLabel: "Cursor",
    strong: ["CURSOR_AGENT", "CURSOR_TRACE_ID", "CURSOR_WORKSPACE_LABEL", "CURSOR_SANDBOX", "CURSOR_"],
    weak: [],
    modelEnv: [],
    defaultModel: HOST_MODEL,
    profiles: ["low", "high"],
    reason: "Cursor host: host-default floor/ceiling effort sweep on the host-agent model",
  },
  {
    host: "claude-code",
    hostLabel: "Claude Code",
    strong: ["CLAUDECODE", "CLAUDE_CODE_", "CLAUDE_"],
    weak: ["ANTHROPIC_"],
    modelEnv: ["ANTHROPIC_MODEL", "CLAUDE_MODEL"],
    defaultModel: "sonnet",
    profiles: ["sonnet"],
    reason: "Claude Code host: run the Claude (sonnet) model profile",
  },
  {
    host: "codex",
    hostLabel: "OpenAI Codex",
    strong: ["CODEX_SANDBOX", "CODEX_HOME", "CODEX_"],
    weak: ["OPENAI_"],
    modelEnv: ["CODEX_MODEL", "OPENAI_MODEL"],
    defaultModel: "gpt-5.5",
    profiles: ["gpt5"],
    reason: "OpenAI Codex host: run the GPT (gpt5) model profile",
  },
  {
    host: "ci",
    hostLabel: "Generic CI",
    strong: ["GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "CIRCLECI", "CI"],
    weak: [],
    modelEnv: [],
    defaultModel: null,
    profiles: ["low", "high"],
    reason: "Generic CI runner: host-default floor/ceiling effort sweep",
  },
];

/** Keys in `env` (non-empty) that match any of `patterns` (prefix if trailing `_`). */
function matchingKeys(env: Record<string, string | undefined>, patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  return Object.keys(env)
    .filter((k) => {
      const v = env[k];
      if (typeof v !== "string" || v.trim() === "") return false;
      return patterns.some((p) => (p.endsWith("_") ? k.startsWith(p) : k === p));
    })
    .sort();
}

/** First non-empty value among `keys`, else null. */
function firstValue(env: Record<string, string | undefined>, keys: string[]): string | null {
  for (const k of keys) {
    const v = env[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/** Resolve suggested profile names into a ProfileSuggestion (matrix = cross-model). */
function suggest(profileNames: string[], reason: string): ProfileSuggestion {
  const resolved = profileNames.map((n) => getProfile(n));
  return { profiles: profileNames, matrix: profilesAreCrossModel(resolved), reason };
}

/**
 * Inspect `env` (+ the Node runtime) and return the host identity, provenance,
 * and a profile suggestion. Strong host markers win over weak ones, and any
 * agent host wins over a generic CI signal. Falls back to `unknown`/host-default.
 */
export function probeHarness(env: Record<string, string | undefined> = process.env): HarnessProbe {
  const base = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    detectedAt: new Date().toISOString(),
  };

  // Strong markers first (in rule order), then weak markers (in rule order).
  let matched: { rule: HostRule; confidence: "high" | "low"; hits: string[] } | null = null;
  for (const rule of RULES) {
    const hits = matchingKeys(env, rule.strong);
    if (hits.length) {
      matched = { rule, confidence: "high", hits };
      break;
    }
  }
  if (!matched) {
    for (const rule of RULES) {
      const hits = matchingKeys(env, rule.weak);
      if (hits.length) {
        matched = { rule, confidence: "low", hits };
        break;
      }
    }
  }

  if (!matched) {
    return {
      host: "unknown",
      hostLabel: "Unknown host",
      model: null,
      confidence: "none",
      ...base,
      signals: [],
      suggestion: suggest(
        ["low", "high"],
        "Could not detect a host harness: host-default floor/ceiling effort sweep",
      ),
    };
  }

  const { rule, confidence, hits } = matched;
  const modelHits = matchingKeys(env, rule.modelEnv);
  const signals = [...new Set([...hits, ...modelHits])].sort();
  return {
    host: rule.host,
    hostLabel: rule.hostLabel,
    model: firstValue(env, rule.modelEnv) ?? rule.defaultModel,
    confidence,
    ...base,
    signals,
    suggestion: suggest(rule.profiles, rule.reason),
  };
}
