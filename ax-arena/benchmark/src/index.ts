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
