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
  providerFor(oracle: OracleSpec): OracleProvider | undefined;
}

/** Build an isolated provider registry for one verification or cell run. */
export function createOracleProviderRegistry(
  input: readonly OracleProvider[] = [],
): OracleProviderRegistry {
  const providers = Object.freeze([...input]);
  const ids = new Set<string>();
  for (const provider of providers) {
    if (!provider.id.trim()) throw new Error("oracle provider id must not be empty");
    if (ids.has(provider.id)) {
      throw new Error(`duplicate oracle provider id "${provider.id}"`);
    }
    ids.add(provider.id);
  }

  return Object.freeze({
    providerFor(oracle: OracleSpec): OracleProvider | undefined {
      const matches = providers.filter((provider) => provider.matches(oracle));
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
  return providers.find((p) => p.matches(oracle));
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
    return await provider.verify(oracle, ctx);
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
