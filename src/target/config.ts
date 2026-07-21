/**
 * Target-agnostic credential + sandbox-scope resolution.
 *
 * The runner used to hard-read Asana env vars. Instead, each pack DECLARES what
 * it needs (`auth` + `sandbox_scope`), and this layer resolves those names from
 * the environment. Credentials never live in the pack — only the var names do.
 *
 * Backward compatibility: when a pack declares no `auth`, we fall back to the
 * legacy Asana vars (ASANA_VERIFY_PAT → ASANA_PAT) so existing packs keep working
 * unchanged.
 */
import type { TargetPack, ScopeParam, SurfaceAuth } from "../schemas.js";
import type { SurfaceId } from "../surface/types.js";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export class TargetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetConfigError";
  }
}

const env = (name: string, source: EnvSource = process.env): string | undefined =>
  source[name]?.trim() || undefined;

const GLOBAL_ENV_ALIAS_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ["STRIPE_API_KEY", "STRIPE_TOKEN"],
];

function globalEnvAliases(name: string | undefined): string[] {
  if (!name) return [];
  for (const group of GLOBAL_ENV_ALIAS_GROUPS) {
    if (group.includes(name)) return group.filter((entry) => entry !== name);
  }
  return [];
}

function envCandidates(primary: string | undefined, aliases: string[] = []): string[] {
  const ordered = [primary, ...aliases, ...globalEnvAliases(primary)];
  return [...new Set(ordered.filter((name): name is string => Boolean(name)))];
}

function resolveEnvValue(
  primary: string | undefined,
  aliases: string[] = [],
  source: EnvSource = process.env,
): string | undefined {
  for (const name of envCandidates(primary, aliases)) {
    const value = env(name, source);
    if (value) return value;
  }
  return undefined;
}

function envHint(primary: string | undefined, aliases: string[] = []): string {
  const names = envCandidates(primary, aliases);
  if (names.length === 0) return "(unset)";
  if (names.length === 1) return names[0]!;
  return `${names[0]} (aliases: ${names.slice(1).join(", ")})`;
}

function envTemplateNames(value: unknown): string[] {
  const names: string[] = [];
  const collectFromString = (text: string) => {
    for (const match of text.matchAll(/\$\{([A-Z0-9_]+)\}/g)) {
      if (match[1]) names.push(match[1]);
    }
  };
  const visit = (item: unknown) => {
    if (typeof item === "string") {
      collectFromString(item);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (item && typeof item === "object") {
      for (const child of Object.values(item as Record<string, unknown>)) visit(child);
    }
  };
  visit(value);
  return [...new Set(names)];
}

/** Resolve the credential the runner uses for verification/oracles. Prefers the
 *  pack's declared `verify_env` then `env`; legacy fallback = ASANA_VERIFY_PAT
 *  → ASANA_PAT so packs without an `auth` block still work. */
export function resolveToken(pack: TargetPack, source: EnvSource = process.env): string {
  const a = pack.auth;
  if (a?.type === "none") return "";
  const candidates = a?.env
    ? [
        envCandidates(a.verify_env, a.verify_env_aliases),
        envCandidates(a.env, a.env_aliases),
      ].flat()
    : ["ASANA_VERIFY_PAT", "ASANA_PAT"];
  for (const name of candidates) {
    const v = env(name, source);
    if (v) return v;
  }
  const named = a?.env
    ? [envHint(a.verify_env, a.verify_env_aliases), envHint(a.env, a.env_aliases)]
      .filter((hint) => hint !== "(unset)")
      .join(" or ")
    : "ASANA_PAT";
  throw new TargetConfigError(
    `Missing credential for ${pack.name}: set ${named} in .env (the agent's sandbox key).`,
  );
}

/** The HTTP header name for the credential. Defaults by auth type. */
export function authHeader(pack: TargetPack): string {
  return pack.auth?.header ?? "Authorization";
}

/** Substitute `${ENV_VAR}` references (e.g. in `base_url` for vendors whose
 *  API host is per-account, like Supabase's `https://${SUPABASE_PROJECT_REF}.supabase.co`)
 *  from process.env. Throws if a referenced var is unset — a silent empty
 *  substitution would just 404 confusingly at request time.
 *
 *  Deliberately NOT applied inside loadPack(): approval hashes the pack's
 *  template form, so the hash stays stable across different developers'
 *  env values. Substitution only happens right before a live HTTP call. */
export function resolveEnvTemplate(text: string, source: EnvSource = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const value = env(name, source);
    if (!value) {
      throw new TargetConfigError(`base_url/path references \${${name}}, but that env var is unset in .env`);
    }
    return value;
  });
}

/** Apply a scope param's optional `url_pattern` to extract an id from a pasted
 *  URL; otherwise return the raw (trimmed) value. */
function extractScopeValue(param: ScopeParam, raw: string): string {
  const trimmed = raw.trim();
  if (param.url_pattern) {
    try {
      const m = trimmed.match(new RegExp(param.url_pattern));
      if (m?.[1]) return m[1];
    } catch {
      /* bad pattern in pack — fall through to raw */
    }
  }
  return trimmed;
}

/** Resolve every declared sandbox-scope value from the environment. Throws if a
 *  required one is missing. Returns a `{ name: value }` map. */
export function resolveScope(pack: TargetPack, source: EnvSource = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const param of pack.sandbox_scope) {
    const raw = env(param.env, source);
    if (!raw) {
      if (param.required) {
        const hint = param.instructions ? ` — ${param.instructions}` : "";
        throw new TargetConfigError(`Missing ${param.env} (sandbox ${param.name})${hint}.`);
      }
      continue;
    }
    out[param.name] = extractScopeValue(param, raw);
  }
  return out;
}

export interface EnvRequirement {
  /** Logical role: "auth" or a scope param name. */
  role: string;
  env: string;
  required: boolean;
  set: boolean;
  instructions?: string;
}

/** Everything the developer must set for this pack, with which vars are present.
 *  Drives a target-agnostic `check-env`. */
export function describeRequiredEnv(pack: TargetPack, source: EnvSource = process.env): EnvRequirement[] {
  const reqs: EnvRequirement[] = [];
  const pushUnique = (req: EnvRequirement) => {
    if (reqs.some((existing) => existing.env === req.env && existing.role === req.role)) return;
    reqs.push(req);
  };
  const authEnv = pack.auth?.env || "ASANA_PAT";
  const authAliases = pack.auth?.env_aliases ?? [];
  const verifyEnv = pack.auth?.verify_env;
  const verifyAliases = pack.auth?.verify_env_aliases ?? [];
  if (pack.auth?.type !== "none") {
    pushUnique({
      role: "auth",
      env: authEnv,
      required: true,
      set: Boolean(
        resolveEnvValue(verifyEnv, verifyAliases, source)
        || resolveEnvValue(authEnv, authAliases, source),
      ),
      instructions: [
        "the agent's sandbox credential",
        envCandidates(authEnv, authAliases).length > 1 ? `aliases accepted: ${envCandidates(authEnv, authAliases).slice(1).join(", ")}` : "",
      ].filter(Boolean).join(" — "),
    });
  }
  for (const name of envTemplateNames([
    pack.base_url,
    pack.tasks.flatMap((task) => task.oracles.map((oracle) => [
      oracle.readPathTemplate,
      oracle.readBodyTemplate,
      oracle.readQueryTemplate,
      oracle.sqlQuery,
      oracle.mongoQuery,
    ])),
  ])) {
    pushUnique({
      role: "env_template",
      env: name,
      required: true,
      set: Boolean(env(name, source)),
      instructions: "required by a pack URL or verifier template",
    });
  }
  for (const p of pack.sandbox_scope) {
    pushUnique({
      role: p.name,
      env: p.env,
      required: p.required,
      set: Boolean(env(p.env, source)),
      instructions: p.instructions || undefined,
    });
  }
  if (pack.sql_conn?.connection_string_env) {
    pushUnique({
      role: "sql_conn",
      env: pack.sql_conn.connection_string_env,
      required: true,
      set: Boolean(env(pack.sql_conn.connection_string_env, source)),
      instructions: `${pack.sql_conn.dialect} connection string used by SQL outcome verifiers`,
    });
  }
  if (pack.mongo_conn?.connection_string_env) {
    pushUnique({
      role: "mongo_conn",
      env: pack.mongo_conn.connection_string_env,
      required: true,
      set: Boolean(env(pack.mongo_conn.connection_string_env, source)),
      instructions: "MongoDB connection string used by Mongo outcome verifiers",
    });
  }
  return reqs;
}

/** True if all required env for this pack is present. */
export function hasRequiredEnv(pack: TargetPack, source: EnvSource = process.env): boolean {
  return describeRequiredEnv(pack, source).every((r) => !r.required || r.set);
}

/** Why a surface can't be evaluated headlessly. `null` = runnable. */
export type SurfaceBlock = "missing-credential" | "requires-oauth";

export interface SurfaceAuthStatus {
  surface: SurfaceId;
  kind: "inherit" | "token" | "oauth_app";
  /** Env vars this surface's auth needs (auth only; sandbox scope is shared). */
  requirements: EnvRequirement[];
  /** Block reason if a required credential is unset; null when runnable. */
  blocked: SurfaceBlock | null;
  /** Required-but-unset env names (the exact keys to add to .env). */
  missing: string[];
  /** Where to provision them (from the surface's auth.instructions). */
  instructions?: string;
}

/** The declared auth block for a non-API surface (undefined ⇒ inherit the API
 *  credential, the safe default for an SDK/CLI that wraps the same REST token). */
function surfaceAuth(pack: TargetPack, surface: SurfaceId): SurfaceAuth | undefined {
  if (surface === "api") return undefined;
  return pack.surfaces?.[surface]?.auth;
}

/** The env var holding the top-level API credential (legacy fallback ASANA_PAT). */
function apiAuthEnv(pack: TargetPack): string {
  return pack.auth?.env || "ASANA_PAT";
}

function apiAuthAliases(pack: TargetPack): string[] {
  return pack.auth?.env_aliases ?? [];
}

/**
 * Resolve what a surface needs to authenticate and whether it's currently
 * blocked. This is the single source of truth behind `check-env --surface`,
 * `init --surface`, and the `blocked:` cube state exec-plan emits. It only
 * inspects auth env NAMES (never values beyond presence), so it's safe to call
 * anywhere — it never logs or returns a secret.
 */
export function surfaceAuthStatus(
  pack: TargetPack,
  surface: SurfaceId,
  source: EnvSource = process.env,
): SurfaceAuthStatus {
  const a = surfaceAuth(pack, surface);
  const kind = surface === "api" ? "inherit" : (a?.kind ?? "inherit");
  const instructions = a?.instructions;
  if (kind === "inherit" && pack.auth?.type === "none") {
    return { surface, kind, requirements: [], blocked: null, missing: [], instructions };
  }
  const req = (envName: string, role: string): EnvRequirement => ({
    role,
    env: envName,
    required: true,
    set: Boolean(resolveEnvValue(envName, [], source)),
    instructions,
  });

  if (kind === "oauth_app") {
    const names: Array<[string | undefined, string]> = [
      [a?.client_id_env, "oauth client id"],
      [a?.client_secret_env, "oauth client secret"],
      [a?.refresh_token_env, "oauth refresh token"],
    ];
    const requirements = names.filter(([n]) => n).map(([n, role]) => req(n as string, role));
    const missing = requirements.filter((r) => !r.set).map((r) => r.env);
    // OAuth-only surfaces have NO headless token path: any missing piece (or no
    // app declared at all) blocks the cell as requires-oauth, distinct from a
    // plain missing token.
    const blocked = requirements.length === 0 || missing.length > 0 ? "requires-oauth" : null;
    return { surface, kind, requirements, blocked, missing, instructions };
  }

  // token / inherit: a single credential. "token" uses the surface's own
  // token_env; "inherit" (and api) reuse the top-level API credential.
  const envName = kind === "token" ? a?.token_env || apiAuthEnv(pack) : apiAuthEnv(pack);
  const aliases = kind === "token" ? (a?.token_env_aliases ?? []) : apiAuthAliases(pack);
  const role = kind === "token" ? `${surface} token` : "auth";
  const requirement = {
    ...req(envName, role),
    set: Boolean(resolveEnvValue(envName, aliases, source)),
    instructions: [
      instructions,
      envCandidates(envName, aliases).length > 1 ? `aliases accepted: ${envCandidates(envName, aliases).slice(1).join(", ")}` : "",
    ].filter(Boolean).join(" — ") || undefined,
  };
  const missing = requirement.set ? [] : [envHint(envName, aliases)];
  return {
    surface,
    kind,
    requirements: [requirement],
    blocked: requirement.set ? null : "missing-credential",
    missing,
    instructions,
  };
}
