/**
 * Pluggable read-back oracle providers.
 *
 * Core ships the HTTP round-trip verifier (REST + GraphQL) in verify.ts.
 * Vertical-specific read-back protocols (e.g. SQL or MongoDB wire checks for
 * the database benchmark) register a provider here instead of branching inside
 * core verify code. A provider owns an oracle spec when `matches` returns
 * true; verification of that oracle is then delegated to it entirely, before
 * the built-in HTTP round-trip path is considered.
 */
import type { TraceStep } from "../harness/executor.js";
import type { OracleResult, OracleSpec, TargetPack, Task } from "../schemas.js";
import { redactSensitiveText } from "../safety/redaction.js";

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function isDeepFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== "object") return true;
  if (seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).every((nested) => isDeepFrozen(nested, seen));
}

function immutableCopy<T>(value: T): T {
  if (value === null || typeof value !== "object" || isDeepFrozen(value)) return value;
  return deepFreeze(structuredClone(value));
}

function snapshotOracleProvider(provider: VersionedOracleProvider): VersionedOracleProvider {
  const snapshot: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(provider)) {
    if (typeof value !== "function") snapshot[name] = immutableCopy(value);
  }
  for (const [name, value] of Object.entries(provider)) {
    if (typeof value === "function") snapshot[name] = value.bind(snapshot);
  }
  snapshot.matches = provider.matches.bind(snapshot);
  snapshot.verify = provider.verify.bind(snapshot);
  return Object.freeze(snapshot) as unknown as VersionedOracleProvider;
}

export interface OracleVerifyContext {
  pack: TargetPack;
  task: Task;
  /** Executor-reported ids for this task ({ gid } plus any extra keys). */
  reported: ({ gid?: string } & Record<string, unknown>) | undefined;
  /** Per-run namespace, substituted into {ns} templates. */
  ns: string | undefined;
  /** Observed trace steps (may be empty). */
  trace: TraceStep[];
  /** Explicit per-call verifier credentials. Providers must not read process.env. */
  credentials: Readonly<Record<string, string | undefined>>;
}

export interface OracleProvider {
  /** Stable id (e.g. "sql", "mongo"). Registering the same id replaces. */
  id: string;
  /** Optional only for the deprecated process-global compatibility API. */
  version?: string;
  /** True if this provider owns the given oracle spec. */
  matches(oracle: OracleSpec): boolean;
  /** Run the read-back check for one oracle this provider matched. */
  verify(
    oracle: OracleSpec,
    ctx: OracleVerifyContext,
  ): Promise<OracleResult | readonly OracleResult[]>;
}

/** Immutable per-run providers require a concrete provenance version. */
export interface VersionedOracleProvider extends OracleProvider {
  version: string;
}

/** @deprecated Use OracleProvider directly for legacy global registration. */
export type LegacyOracleProvider = OracleProvider;

export interface OracleProviderRegistry {
  readonly providers: readonly VersionedOracleProvider[];
  providerFor(oracle: OracleSpec): VersionedOracleProvider | undefined;
}

/** Build an isolated provider registry for one verification or cell run. */
export function createOracleProviderRegistry(
  input: readonly VersionedOracleProvider[] = [],
): OracleProviderRegistry {
  const providers = Object.freeze(input.map((provider) => {
    if (typeof provider.id !== "string" || !provider.id.trim()) {
      throw new Error("oracle provider id must not be empty");
    }
    if (typeof provider.version !== "string" || !provider.version.trim()) {
      throw new Error("oracle provider version must not be empty");
    }
    return snapshotOracleProvider(provider);
  }));
  const ids = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.id)) {
      throw new Error(`duplicate oracle provider id "${provider.id}"`);
    }
    ids.add(provider.id);
  }
  const selections = new WeakMap<object, {
    provider?: VersionedOracleProvider;
    error?: string;
  }>();

  return Object.freeze({
    providers,
    providerFor(oracle: OracleSpec): VersionedOracleProvider | undefined {
      const cached = selections.get(oracle);
      if (cached) {
        if (cached.error) throw new Error(cached.error);
        return cached.provider;
      }
      const descriptor = immutableCopy(oracle);
      let matches: VersionedOracleProvider[];
      try {
        matches = providers.filter((provider) => {
          return provider.matches(descriptor);
        });
      } catch {
        const error = "oracle provider selection failed";
        selections.set(oracle, { error });
        throw new Error(error);
      }
      if (matches.length > 1) {
        const error = `multiple oracle providers match: ${matches.map((provider) => provider.id).join(", ")}`;
        selections.set(oracle, { error });
        throw new Error(error);
      }
      const selected = matches[0];
      selections.set(oracle, { provider: selected });
      return selected;
    },
  });
}

const providers: VersionedOracleProvider[] = [];

export function registerOracleProvider(provider: LegacyOracleProvider): void {
  if (typeof provider.id !== "string" || !provider.id.trim()) {
    throw new Error("oracle provider id must not be empty");
  }
  const normalized: VersionedOracleProvider = typeof provider.version === "string" && provider.version.trim()
    ? provider as VersionedOracleProvider
    : {
        id: provider.id,
        version: "legacy-unversioned",
        matches: provider.matches.bind(provider),
        verify: provider.verify.bind(provider),
      };
  const existing = providers.findIndex((p) => p.id === normalized.id);
  if (existing >= 0) providers[existing] = normalized;
  else providers.push(normalized);
}

/** First registered provider claiming the spec, in registration order. */
export function providerForOracle(oracle: OracleSpec): VersionedOracleProvider | undefined {
  const descriptor = immutableCopy(oracle);
  return providers.find((provider) => {
    try {
      return provider.matches(descriptor);
    } catch {
      throw new Error(`oracle provider "${provider.id}" match failed`);
    }
  });
}

/** Test hook: reset the registry. */
export function clearOracleProviders(): void {
  providers.length = 0;
}

/** Delegate one oracle to its provider; a throwing provider becomes a failed
 *  result rather than aborting the surrounding task's verification. */
export async function runProviderOracle(
  provider: VersionedOracleProvider,
  oracle: OracleSpec,
  ctx: OracleVerifyContext,
): Promise<OracleResult[]> {
  try {
    const result = await provider.verify(immutableCopy(oracle), immutableCopy(ctx));
    const results = Array.isArray(result) ? [...result] : [result as OracleResult];
    if (!results.length || results.some((entry) => !entry
      || typeof entry.type !== "string"
      || typeof entry.passed !== "boolean"
      || typeof entry.detail !== "string")) {
      throw new Error("provider returned invalid oracle evidence");
    }
    const secrets = Object.values(ctx.credentials)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .sort((a, b) => b.length - a.length);
    return results.map((entry) => {
      const detail = secrets.some((secret) => secret.length < 4 && entry.detail.includes(secret))
        ? "<redacted-sensitive-text>"
        : secrets.reduce(
            (value, secret) => secret.length >= 4 ? value.split(secret).join("<redacted>") : value,
            entry.detail,
          );
      return {
        // Providers may emit the original oracle result plus a verifier probe.
        // Other type labels are not trusted record fields and collapse to the
        // reviewed oracle type instead of becoming a covert data channel.
        type: entry.type === oracle.type || entry.type === "verifier-probe"
          ? entry.type
          : oracle.type,
        passed: entry.passed,
        detail: redactSensitiveText(detail),
      };
    });
  } catch {
    return [{
      type: oracle.type,
      passed: false,
      // Provider exceptions may embed credentials or connection strings. The
      // provider boundary is not a trusted diagnostic channel, so fail closed
      // without copying exception text into records or reports.
      detail: `oracle provider "${provider.id}" failed`,
    }];
  }
}
