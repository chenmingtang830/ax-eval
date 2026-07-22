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

function snapshotOracleProvider(provider: OracleProvider): OracleProvider {
  const snapshot: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(provider)) {
    if (typeof value !== "function") snapshot[name] = immutableCopy(value);
  }
  for (const [name, value] of Object.entries(provider)) {
    if (typeof value === "function") snapshot[name] = value.bind(snapshot);
  }
  snapshot.matches = provider.matches.bind(snapshot);
  snapshot.verify = provider.verify.bind(snapshot);
  return Object.freeze(snapshot) as unknown as OracleProvider;
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
}

export interface OracleProvider {
  /** Stable id (e.g. "sql", "mongo"). Registering the same id replaces. */
  id: string;
  /** True if this provider owns the given oracle spec. */
  matches(oracle: OracleSpec): boolean;
  /** Run the read-back check for one oracle this provider matched. */
  verify(oracle: OracleSpec, ctx: OracleVerifyContext): Promise<OracleResult>;
}

export interface OracleProviderRegistry {
  readonly providers: readonly OracleProvider[];
  providerFor(oracle: OracleSpec): OracleProvider | undefined;
}

/** Build an isolated provider registry for one verification or cell run. */
export function createOracleProviderRegistry(
  input: readonly OracleProvider[] = [],
): OracleProviderRegistry {
  const providers = Object.freeze(input.map((provider) => {
    if (typeof provider.id !== "string" || !provider.id.trim()) {
      throw new Error("oracle provider id must not be empty");
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

  return Object.freeze({
    providers,
    providerFor(oracle: OracleSpec): OracleProvider | undefined {
      const descriptor = immutableCopy(oracle);
      const matches = providers.filter((provider) => {
        try {
          return provider.matches(descriptor);
        } catch {
          throw new Error(`oracle provider "${provider.id}" match failed`);
        }
      });
      if (matches.length > 1) {
        throw new Error(`multiple oracle providers match: ${matches.map((provider) => provider.id).join(", ")}`);
      }
      return matches[0];
    },
  });
}

const providers: OracleProvider[] = [];

export function registerOracleProvider(provider: OracleProvider): void {
  const existing = providers.findIndex((p) => p.id === provider.id);
  if (existing >= 0) providers[existing] = provider;
  else providers.push(provider);
}

/** First registered provider claiming the spec, in registration order. */
export function providerForOracle(oracle: OracleSpec): OracleProvider | undefined {
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
  provider: OracleProvider,
  oracle: OracleSpec,
  ctx: OracleVerifyContext,
): Promise<OracleResult> {
  try {
    return await provider.verify(immutableCopy(oracle), immutableCopy(ctx));
  } catch (err) {
    return {
      type: oracle.type,
      passed: false,
      // Provider exceptions may embed credentials or connection strings. The
      // provider boundary is not a trusted diagnostic channel, so fail closed
      // without copying exception text into records or reports.
      detail: `oracle provider "${provider.id}" failed`,
    };
  }
}
