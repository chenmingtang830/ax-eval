import { describe, expect, it, vi } from "vitest";
import type { EvaluationCell } from "../src/cell/schema.js";
import type { VersionedOracleProvider } from "../src/generate/oracle-provider.js";
import {
  createResetProviderRegistry,
  createRuntimeExtensionRegistry,
  resolveRuntimeExtensions,
  type ResetProvider,
  type TargetDescriptor,
} from "../src/runtime/extensions.js";
import { TargetPackSchema, type TargetPack } from "../src/schemas.js";

const pack: TargetPack = TargetPackSchema.parse({
  name: "example",
  version: "1",
  standard_set_version: "example-v1",
  generated_by: "deterministic@no-model",
  auth_method: "none",
  auth: { type: "none" },
  base_url: "https://example.invalid",
  site_url: "",
  docs_urls: [],
  tasks: [],
});

const cell = {
  schema: "ax.evaluation-cell/v1",
  cell_id: "cell-1",
  batch_id: "batch-1",
  evaluation_set_id: "set-1",
  evaluation_set_version: "example-v1",
  target_id: "example",
  pack: { path: "pack.yaml", content_hash: "0".repeat(64) },
  surface: "api",
  harness: { id: "codex", profile: "medium", model: "gpt-example", effort: "medium" },
  trial: 1,
  source_commit_sha: "a".repeat(40),
  required_credentials: [],
  run_context: {
    cwd: "/tmp/example",
    artifact_dir: "artifacts",
    invoke_timeout_ms: 1,
    first_action_timeout_ms: 1,
    invoke_retries: 0,
  },
} as EvaluationCell;

const target: TargetDescriptor = { cell, pack };

function resetProvider(id: string, matches = true): ResetProvider {
  return {
    id,
    version: "1.0.0",
    matches() {
      return matches && this.id === id;
    },
    async plan() {
      return { summary: "one resource", resources: ["resource-1"] };
    },
    async execute() {
      return { supported: true, message: "done", deleted: ["resource-1"], errors: [] };
    },
  };
}

describe("runtime extension registries", () => {
  it("takes an immutable provider snapshot instead of retaining caller mutations", () => {
    const original = {
      ...resetProvider("reset-a"),
      state: { enabled: true },
      matches() {
        return this.id === "reset-a" && this.state.enabled;
      },
    };
    const registry = createResetProviderRegistry([original]);
    (original as { id: string }).id = "mutated";
    (original as { version: string }).version = "9.9.9";
    original.state.enabled = false;

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.providers)).toBe(true);
    expect(Object.isFrozen(registry.providers[0])).toBe(true);
    expect(registry.providerFor(target)).toMatchObject({ id: "reset-a", version: "1.0.0" });
  });

  it("rejects blank identities, duplicate ids, and ambiguous matches deterministically", () => {
    expect(() => createResetProviderRegistry([{ ...resetProvider("reset"), version: "" }]))
      .toThrow(/version must not be empty/);
    expect(() => createResetProviderRegistry([resetProvider("same"), resetProvider("same")]))
      .toThrow(/duplicate reset provider id "same"/);
    const ambiguous = createResetProviderRegistry([resetProvider("a"), resetProvider("b")]);
    expect(() => ambiguous.providerFor(target)).toThrow(/multiple reset providers match: a, b/);
  });

  it("does not expose mutable cell or reviewed-pack objects to provider matching", () => {
    const registry = createResetProviderRegistry([{
      ...resetProvider("mutator"),
      matches(descriptor) {
        (descriptor.pack as { name: string }).name = "changed";
        return true;
      },
    }]);

    expect(() => registry.providerFor(target)).toThrow('reset provider "mutator" match failed');
    expect(pack.name).toBe("example");
    expect(cell.target_id).toBe("example");
  });

  it("composes adapter providers and reports sorted versioned provenance", () => {
    const oracle: VersionedOracleProvider = {
      id: "sql",
      version: "2.1.0",
      matches: () => true,
      verify: vi.fn(),
    };
    const registry = createRuntimeExtensionRegistry({
      resetProviders: [resetProvider("root-reset", false)],
      targetAdapters: [{
        id: "example-adapter",
        version: "3.0.0",
        matches: ({ pack: candidate }) => candidate.name === "example",
        oracleProviders: [oracle],
        resetProviders: [resetProvider("adapter-reset")],
      }],
    });

    expect(registry.inspect()).toEqual([
      { kind: "reset", id: "root-reset", version: "1.0.0" },
      { kind: "target-adapter", id: "example-adapter", version: "3.0.0" },
    ]);
    const resolved = resolveRuntimeExtensions(registry, target);
    expect(resolved.targetAdapter?.id).toBe("example-adapter");
    expect(resolved.resetProviders.providerFor(target)?.id).toBe("adapter-reset");
    expect(resolved.provenance).toEqual([
      { kind: "oracle", id: "sql", version: "2.1.0" },
      { kind: "reset", id: "adapter-reset", version: "1.0.0" },
      { kind: "reset", id: "root-reset", version: "1.0.0" },
      { kind: "target-adapter", id: "example-adapter", version: "3.0.0" },
    ]);
  });

  it("preserves target-adapter methods defined on a class prototype", () => {
    class ExampleAdapter {
      readonly id = "class-adapter";
      readonly version = "1.0.0";

      matches(descriptor: TargetDescriptor): boolean {
        return descriptor.pack.name === "example" && this.id === "class-adapter";
      }

      verificationClientOptions() {
        return {
          baseUrl: `https://${this.id}.example.invalid`,
          token: "",
          authScheme: "none" as const,
          apiStyle: "rest" as const,
        };
      }
    }

    const resolved = resolveRuntimeExtensions(
      createRuntimeExtensionRegistry({ targetAdapters: [new ExampleAdapter()] }),
      target,
    );
    expect(resolved.targetAdapter).toMatchObject({ id: "class-adapter", version: "1.0.0" });
    expect(resolved.targetAdapter?.verificationClientOptions?.({
      ...target,
      executor: { profile: "test", results: {} },
      credentials: {},
      trace: [],
    })).toMatchObject({ baseUrl: "https://class-adapter.example.invalid" });
  });

  it("keeps independently resolved registries isolated under concurrent use", async () => {
    const a = createRuntimeExtensionRegistry({ resetProviders: [resetProvider("reset-a")] });
    const b = createRuntimeExtensionRegistry({ resetProviders: [resetProvider("reset-b")] });

    const [providerA, providerB] = await Promise.all([
      Promise.resolve(resolveRuntimeExtensions(a, target).resetProviders.providerFor(target)),
      Promise.resolve(resolveRuntimeExtensions(b, target).resetProviders.providerFor(target)),
    ]);
    expect(providerA?.id).toBe("reset-a");
    expect(providerB?.id).toBe("reset-b");
  });
});
