import { describe, expect, it } from "vitest";
import {
  AX_ARENA_BENCHMARK_PACKAGE,
  createArenaRuntimeExtensionRegistry,
} from "../src/index.js";

describe("arena public engine boundary", () => {
  it("composes extensions through the public ax-eval package specifier", () => {
    expect(AX_ARENA_BENCHMARK_PACKAGE).toBe("@ax-arena/benchmark");
    expect(createArenaRuntimeExtensionRegistry().inspect()).toEqual([]);
  });
});
