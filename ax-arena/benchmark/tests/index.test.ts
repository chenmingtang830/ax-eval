import { describe, expect, it } from "vitest";
import {
  AX_ARENA_BENCHMARK_PACKAGE,
  createArenaRuntimeExtensionRegistry,
  createDatabaseRuntimeExtensionRegistry,
} from "../src/index.js";

describe("arena public engine boundary", () => {
  it("composes extensions through the public ax-eval package specifier", () => {
    expect(AX_ARENA_BENCHMARK_PACKAGE).toBe("@ax-arena/benchmark");
    expect(createArenaRuntimeExtensionRegistry().inspect()).toEqual([]);
  });

  it("builds an isolated registry containing arena-owned database providers", () => {
    const first = createDatabaseRuntimeExtensionRegistry({ searchPath: "" });
    const second = createDatabaseRuntimeExtensionRegistry({ searchPath: "" });

    expect(first).not.toBe(second);
    expect(first.inspect()).toEqual(expect.arrayContaining([
      { kind: "oracle", id: "arena-sql", version: "1.0.0" },
      { kind: "oracle", id: "arena-mongo", version: "1.0.0" },
      { kind: "reset", id: "ax-arena-postgres-reset", version: "1.0.0" },
      { kind: "provisioning", id: "ax-arena-turso-cli", version: "1.0.0" },
      { kind: "health-check", id: "ax-arena-mongodb-atlas-health", version: "1.0.0" },
    ]));
  });
});
