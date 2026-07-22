import {
  createRuntimeExtensionRegistry,
  type RuntimeExtensionInput,
  type RuntimeExtensionRegistry,
} from "ax-eval";

export const AX_ARENA_BENCHMARK_PACKAGE = "@ax-arena/benchmark" as const;

/** Arena composes target-specific implementations through the public engine
 * boundary. No arena source may import ax-eval/src/**. */
export function createArenaRuntimeExtensionRegistry(
  input: RuntimeExtensionInput = {},
): RuntimeExtensionRegistry {
  return createRuntimeExtensionRegistry(input);
}

export * from "./authoring/coverage-gap-check.js";
export * from "./authoring/database-task-fit.js";
export * from "./authoring/database-policy.js";
export * from "./authoring/extract-advisory.js";
export * from "./authoring/extract-audit.js";
export * from "./authoring/pack-audit.js";
export * from "./authoring/suite-audit.js";
export * from "./authoring/synthesize-suite.js";
export * from "./authoring/vendor-selection.js";
