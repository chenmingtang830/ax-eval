import type { EvaluationCell } from "../cell/schema.js";
import {
  createOracleProviderRegistry,
  type OracleProviderRegistry,
  type VersionedOracleProvider,
} from "../generate/oracle-provider.js";
import type { TargetPack } from "../schemas.js";

export type RuntimeExtensionKind =
  | "oracle"
  | "reset"
  | "provisioning"
  | "health-check"
  | "target-adapter";

export interface ProviderIdentity {
  readonly id: string;
  readonly version: string;
}

export interface ProviderReference extends ProviderIdentity {
  readonly kind: RuntimeExtensionKind;
}

export interface TargetDescriptor {
  readonly cell: EvaluationCell;
  readonly pack: TargetPack;
}

export interface ResetPlan {
  /** Human-readable, redacted description suitable for a cleanup sidecar. */
  readonly summary: string;
  /** Exact bounded resource identities the provider intends to delete. */
  readonly resources: readonly string[];
}

export interface ResetEvidence {
  readonly supported: boolean;
  readonly message: string;
  readonly deleted: readonly string[];
  readonly errors: readonly string[];
}

export interface ResetContext extends TargetDescriptor {
  readonly credentials: Readonly<Record<string, string>>;
  readonly scope: Readonly<Record<string, string>>;
  readonly namespace: string;
  readonly dryRun: boolean;
  readonly signal?: AbortSignal;
}

export interface ResetProvider extends ProviderIdentity {
  matches(target: TargetDescriptor): boolean;
  plan(context: ResetContext): Promise<ResetPlan>;
  execute(plan: ResetPlan, context: ResetContext): Promise<ResetEvidence>;
}

export interface ProvisioningInspection {
  readonly ready: boolean;
  readonly detail?: string;
}

export interface ProvisioningContext extends TargetDescriptor {
  readonly cwd: string;
  readonly artifactDir: string;
  /** Only harness-visible credentials declared by the immutable cell are
   * present; independent verifier-only credentials are excluded. */
  readonly credentials: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface ProvisioningEvidence {
  /** Additive child-process environment. Existing keys may not be replaced. */
  readonly env?: Readonly<Record<string, string>>;
  /** Trusted executable directories prepended to the child PATH after core
   * verifies they resolve outside the writable cell and artifact trees. */
  readonly pathEntries?: readonly string[];
  /** Non-secret data written to invocation metadata and provider provenance. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProvisioningProvider extends ProviderIdentity {
  matches(target: TargetDescriptor): boolean;
  inspect(context: Omit<ProvisioningContext, "credentials">): Promise<ProvisioningInspection>;
  provision(context: ProvisioningContext): Promise<ProvisioningEvidence>;
}

export interface HealthCheckEvidence {
  readonly status: "pass" | "warn" | "fail";
  readonly message: string;
}

export interface HealthCheckContext extends TargetDescriptor {
  readonly credentials: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface HealthCheckProvider extends ProviderIdentity {
  matches(target: TargetDescriptor): boolean;
  check(context: HealthCheckContext): Promise<readonly HealthCheckEvidence[]>;
}

export interface TargetAdapter extends ProviderIdentity {
  matches(target: TargetDescriptor): boolean;
  /** Prompt and verification-transport hooks are added only when runCell can
   * execute them; this slice limits adapters to composing narrower providers. */
  readonly oracleProviders?: readonly VersionedOracleProvider[];
  readonly resetProviders?: readonly ResetProvider[];
  readonly provisioningProviders?: readonly ProvisioningProvider[];
  readonly healthCheckProviders?: readonly HealthCheckProvider[];
}

interface MatchRegistry<T extends ProviderIdentity> {
  readonly providers: readonly T[];
  providerFor(target: TargetDescriptor): T | undefined;
}

export type ResetProviderRegistry = MatchRegistry<ResetProvider>;
export type ProvisioningProviderRegistry = MatchRegistry<ProvisioningProvider>;
export type HealthCheckProviderRegistry = MatchRegistry<HealthCheckProvider>;
export type TargetAdapterRegistry = MatchRegistry<TargetAdapter>;

export interface RuntimeExtensionRegistry {
  readonly oracleProviders: OracleProviderRegistry;
  readonly resetProviders: ResetProviderRegistry;
  readonly provisioningProviders: ProvisioningProviderRegistry;
  readonly healthCheckProviders: HealthCheckProviderRegistry;
  readonly targetAdapters: TargetAdapterRegistry;
  inspect(): readonly ProviderReference[];
}

export interface RuntimeExtensionInput {
  readonly oracleProviders?: readonly VersionedOracleProvider[];
  readonly resetProviders?: readonly ResetProvider[];
  readonly provisioningProviders?: readonly ProvisioningProvider[];
  readonly healthCheckProviders?: readonly HealthCheckProvider[];
  readonly targetAdapters?: readonly TargetAdapter[];
}

export interface ResolvedRuntimeExtensions {
  readonly oracleProviders: OracleProviderRegistry;
  readonly resetProviders: ResetProviderRegistry;
  readonly provisioningProviders: ProvisioningProviderRegistry;
  readonly healthCheckProviders: HealthCheckProviderRegistry;
  readonly targetAdapter?: TargetAdapter;
  /** Configured providers after adapter composition, sorted deterministically. */
  readonly provenance: readonly ProviderReference[];
}

type ProviderMethod =
  | "matches"
  | "plan"
  | "execute"
  | "inspect"
  | "provision"
  | "check";

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

function immutableProviderValue<T>(value: T): T {
  if (value === null || typeof value !== "object" || isDeepFrozen(value)) return value;
  return deepFreeze(structuredClone(value));
}

function immutableTarget(target: TargetDescriptor): TargetDescriptor {
  return deepFreeze(structuredClone(target));
}

function assertIdentity(kind: RuntimeExtensionKind, provider: ProviderIdentity): void {
  if (typeof provider.id !== "string" || !provider.id.trim()) {
    throw new Error(`${kind} provider id must not be empty`);
  }
  if (typeof provider.version !== "string" || !provider.version.trim()) {
    throw new Error(`${kind} provider version must not be empty`);
  }
}

function snapshotProvider<T extends ProviderIdentity>(
  kind: RuntimeExtensionKind,
  provider: T,
  methods: readonly ProviderMethod[],
  excludedProperties: readonly string[] = [],
): T {
  assertIdentity(kind, provider);
  const snapshot: Record<string, unknown> = {};
  const excluded = new Set(excludedProperties);
  for (const [name, value] of Object.entries(provider)) {
    if (excluded.has(name)) continue;
    if (typeof value !== "function") snapshot[name] = immutableProviderValue(value);
  }
  for (const [name, value] of Object.entries(provider)) {
    if (excluded.has(name)) continue;
    if (typeof value === "function") snapshot[name] = value.bind(snapshot);
  }
  for (const method of methods) {
    const fn = provider[method as keyof T];
    if (typeof fn !== "function") throw new Error(`${kind} provider "${provider.id}" is missing ${method}()`);
    if (typeof snapshot[method] !== "function") snapshot[method] = fn.bind(snapshot);
  }
  return Object.freeze(snapshot) as T;
}

function createMatchRegistry<T extends ProviderIdentity>(
  kind: Exclude<RuntimeExtensionKind, "oracle">,
  input: readonly T[],
  methods: readonly ProviderMethod[],
  inputIsSnapshotted = false,
): MatchRegistry<T> {
  const providers = Object.freeze(inputIsSnapshotted
    ? [...input]
    : input.map((provider) => snapshotProvider(kind, provider, methods)));
  const ids = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new Error(`duplicate ${kind} provider id "${provider.id}"`);
    ids.add(provider.id);
  }
  return Object.freeze({
    providers,
    providerFor(target: TargetDescriptor): T | undefined {
      const descriptor = immutableTarget(target);
      const matches = providers.filter((provider) => {
        const candidate = provider as T & { matches(target: TargetDescriptor): boolean };
        try {
          return candidate.matches(descriptor);
        } catch {
          throw new Error(`${kind} provider "${provider.id}" match failed`);
        }
      });
      if (matches.length > 1) {
        throw new Error(`multiple ${kind} providers match: ${matches.map((provider) => provider.id).join(", ")}`);
      }
      return matches[0];
    },
  });
}

export function createResetProviderRegistry(input: readonly ResetProvider[] = []): ResetProviderRegistry {
  return createMatchRegistry("reset", input, ["matches", "plan", "execute"]);
}

export function createProvisioningProviderRegistry(
  input: readonly ProvisioningProvider[] = [],
): ProvisioningProviderRegistry {
  return createMatchRegistry("provisioning", input, ["matches", "inspect", "provision"]);
}

export function createHealthCheckProviderRegistry(
  input: readonly HealthCheckProvider[] = [],
): HealthCheckProviderRegistry {
  return createMatchRegistry("health-check", input, ["matches", "check"]);
}

export function createTargetAdapterRegistry(input: readonly TargetAdapter[] = []): TargetAdapterRegistry {
  const snapshots = input.map((adapter) => {
    // Snapshot first so prototype-defined class methods become bound own
    // properties before composing the adapter's nested provider registries.
    const snapshot = snapshotProvider("target-adapter", adapter, ["matches"], [
      "oracleProviders",
      "resetProviders",
      "provisioningProviders",
      "healthCheckProviders",
    ]);
    return Object.freeze({
      ...snapshot,
      oracleProviders: adapter.oracleProviders
        ? createOracleProviderRegistry(adapter.oracleProviders).providers
        : undefined,
      resetProviders: adapter.resetProviders
        ? createResetProviderRegistry(adapter.resetProviders).providers
        : undefined,
      provisioningProviders: adapter.provisioningProviders
        ? createProvisioningProviderRegistry(adapter.provisioningProviders).providers
        : undefined,
      healthCheckProviders: adapter.healthCheckProviders
        ? createHealthCheckProviderRegistry(adapter.healthCheckProviders).providers
        : undefined,
    });
  });
  return createMatchRegistry("target-adapter", snapshots, ["matches"], true);
}

function reference(kind: RuntimeExtensionKind, provider: ProviderIdentity): ProviderReference {
  return Object.freeze({ kind, id: provider.id, version: provider.version });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedReferences(entries: readonly ProviderReference[]): readonly ProviderReference[] {
  return Object.freeze([...entries].sort((a, b) =>
    compareText(a.kind, b.kind) || compareText(a.id, b.id) || compareText(a.version, b.version)));
}

function registryReferences(registry: RuntimeExtensionRegistry): readonly ProviderReference[] {
  return sortedReferences([
    ...registry.oracleProviders.providers.map((provider) => reference("oracle", provider)),
    ...registry.resetProviders.providers.map((provider) => reference("reset", provider)),
    ...registry.provisioningProviders.providers.map((provider) => reference("provisioning", provider)),
    ...registry.healthCheckProviders.providers.map((provider) => reference("health-check", provider)),
    ...registry.targetAdapters.providers.map((provider) => reference("target-adapter", provider)),
  ]);
}

export function createRuntimeExtensionRegistry(input: RuntimeExtensionInput = {}): RuntimeExtensionRegistry {
  const registry: RuntimeExtensionRegistry = {
    oracleProviders: createOracleProviderRegistry(input.oracleProviders),
    resetProviders: createResetProviderRegistry(input.resetProviders),
    provisioningProviders: createProvisioningProviderRegistry(input.provisioningProviders),
    healthCheckProviders: createHealthCheckProviderRegistry(input.healthCheckProviders),
    targetAdapters: createTargetAdapterRegistry(input.targetAdapters),
    inspect: () => registryReferences(registry),
  };
  return Object.freeze(registry);
}

export function resolveRuntimeExtensions(
  registry: RuntimeExtensionRegistry,
  target: TargetDescriptor,
): ResolvedRuntimeExtensions {
  const adapter = registry.targetAdapters.providerFor(target);
  const oracleProviders = createOracleProviderRegistry([
    ...registry.oracleProviders.providers,
    ...(adapter?.oracleProviders ?? []),
  ]);
  const resetProviders = createResetProviderRegistry([
    ...registry.resetProviders.providers,
    ...(adapter?.resetProviders ?? []),
  ]);
  const provisioningProviders = createProvisioningProviderRegistry([
    ...registry.provisioningProviders.providers,
    ...(adapter?.provisioningProviders ?? []),
  ]);
  const healthCheckProviders = createHealthCheckProviderRegistry([
    ...registry.healthCheckProviders.providers,
    ...(adapter?.healthCheckProviders ?? []),
  ]);
  const provenance = sortedReferences([
    ...oracleProviders.providers.map((provider) => reference("oracle", provider)),
    ...resetProviders.providers.map((provider) => reference("reset", provider)),
    ...provisioningProviders.providers.map((provider) => reference("provisioning", provider)),
    ...healthCheckProviders.providers.map((provider) => reference("health-check", provider)),
    ...(adapter ? [reference("target-adapter", adapter)] : []),
  ]);
  return Object.freeze({
    oracleProviders,
    resetProviders,
    provisioningProviders,
    healthCheckProviders,
    targetAdapter: adapter,
    provenance,
  });
}
