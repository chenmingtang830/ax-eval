import {
  createRuntimeExtensionRegistry,
  type RuntimeExtensionInput,
  type RuntimeExtensionRegistry,
} from "ax-eval";
import {
  DATABASE_HEALTH_CHECK_PROVIDERS,
  DATABASE_RESET_PROVIDERS,
  createMongoOracleProvider,
  createSqlOracleProvider,
  createTursoCliProvisioningProvider,
  type TursoCliProvisioningOptions,
} from "./providers/index.js";

export const AX_ARENA_BENCHMARK_PACKAGE = "@ax-arena/benchmark" as const;

/** Arena composes target-specific implementations through the public engine
 * boundary. No arena source may import ax-eval/src/**. */
export function createArenaRuntimeExtensionRegistry(
  input: RuntimeExtensionInput = {},
): RuntimeExtensionRegistry {
  return createRuntimeExtensionRegistry(input);
}

/** Construct one isolated DAEB database registry. Controller-selected ambient
 * state is explicit so providers never read process.env and cells cannot share
 * mutable registrations. */
export function createDatabaseRuntimeExtensionRegistry(
  tursoCli: TursoCliProvisioningOptions,
  input: RuntimeExtensionInput = {},
): RuntimeExtensionRegistry {
  return createRuntimeExtensionRegistry({
    oracleProviders: [
      createSqlOracleProvider(),
      createMongoOracleProvider(),
      ...(input.oracleProviders ?? []),
    ],
    resetProviders: [
      ...DATABASE_RESET_PROVIDERS,
      ...(input.resetProviders ?? []),
    ],
    provisioningProviders: [
      createTursoCliProvisioningProvider(tursoCli),
      ...(input.provisioningProviders ?? []),
    ],
    healthCheckProviders: [
      ...DATABASE_HEALTH_CHECK_PROVIDERS,
      ...(input.healthCheckProviders ?? []),
    ],
    targetAdapters: input.targetAdapters,
  });
}

export * from "./providers/index.js";
export {
  ARENA_CELL_CLEANUP_SCHEMA,
  ArenaCellCleanupSchema,
  arenaCellId,
  cellCredentialNames,
  cellResetCredentialNames,
  cellVerificationCredentialNames,
  executeArenaCell,
  isRelativePathEscape,
  resolveSourceCommitSha,
} from "./controller/cell.js";
export type {
  ArenaCellCleanupRecord,
  ArenaCellDependencies,
  ArenaCellExecution,
  ArenaCellSpec,
} from "./controller/cell.js";

export * from "./authoring/coverage-gap-check.js";
export * from "./authoring/database-task-fit.js";
export * from "./authoring/database-policy.js";
export * from "./authoring/extract-advisory.js";
export * from "./authoring/extract-audit.js";
export * from "./authoring/pack-audit.js";
export * from "./authoring/suite-audit.js";
export * from "./authoring/synthesize-suite.js";
export * from "./authoring/vendor-selection.js";
