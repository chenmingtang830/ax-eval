import { describe, expect, it } from "vitest";
import {
  EvaluationCellSchema,
  TargetPackSchema,
  resolveRuntimeExtensions,
} from "ax-eval";
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
      { kind: "health-check", id: "ax-arena-postgres-health", version: "1.1.0" },
      { kind: "health-check", id: "ax-arena-mongodb-atlas-health", version: "1.0.0" },
    ]));
  });
  it("selects the arena Turso provider for a pinned CLI cell", () => {
    const registry = createDatabaseRuntimeExtensionRegistry({ searchPath: "" });
    const cell = EvaluationCellSchema.parse({
      schema: "ax.evaluation-cell/v1",
      cell_id: "cell-turso-cli",
      batch_id: "batch-1",
      evaluation_set_id: "daeb",
      evaluation_set_version: "1",
      target_id: "turso",
      pack: { path: "pack.yaml", content_hash: "0".repeat(64) },
      surface: "cli",
      harness: { id: "codex", profile: "medium", model: "test", effort: "medium" },
      trial: 1,
      source_commit_sha: "a".repeat(40),
      required_credentials: [],
      run_context: {
        cwd: "/workspace",
        artifact_dir: "/artifacts",
        invoke_timeout_ms: 1,
        first_action_timeout_ms: 1,
        invoke_retries: 0,
      },
    });
    const pack = TargetPackSchema.parse({
      name: "turso",
      surfaces: { cli: { bin: "turso", auth: { kind: "inherit", token_env_aliases: [] } } },
      tasks: [],
    });

    const provider = resolveRuntimeExtensions(registry, { cell, pack })
      .provisioningProviders.providerFor({ cell, pack });
    expect(provider && { id: provider.id, version: provider.version }).toEqual({
      id: "ax-arena-turso-cli",
      version: "1.0.0",
    });
  });

  it("omits Turso provisioning when the controller did not select a pinned binary", () => {
    expect(createDatabaseRuntimeExtensionRegistry().inspect()).not.toContainEqual(
      { kind: "provisioning", id: "ax-arena-turso-cli", version: "1.0.0" },
    );
  });
});
