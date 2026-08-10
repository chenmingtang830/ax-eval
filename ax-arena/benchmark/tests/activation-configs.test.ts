import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AXARENA_DATABASE_V1_CONFIGURATION_PATHS,
  buildAxArenaDatabaseV1ActivationConfigurations,
  serializeActivationConfiguration,
} from "../src/controller/activation.js";
import { ArenaBatchConfigurationSchema } from "../src/controller/schemas.js";

const ROOT = resolve(import.meta.dirname, "../../..");

describe("AXArena-Database v1 activation configurations", () => {
  const generated = buildAxArenaDatabaseV1ActivationConfigurations(ROOT);

  it("commits byte-identical deterministic configurations", () => {
    for (const [name, relativePath] of Object.entries(AXARENA_DATABASE_V1_CONFIGURATION_PATHS)) {
      expect(readFileSync(resolve(ROOT, relativePath), "utf8"))
        .toBe(serializeActivationConfiguration(generated[name as keyof typeof generated]));
    }
  });

  it("defines the exact executable 6-cell calibration cohort", () => {
    expect(generated.calibration.cells).toHaveLength(6);
    expect(new Set(generated.calibration.cells.map((cell) => cell.vendor))).toEqual(new Set(["supabase", "turso"]));
    expect(generated.calibration.cells.filter((cell) => cell.vendor === "supabase")
      .every((cell) => cell.surface === "cli")).toBe(true);
    expect(new Set(generated.calibration.cells.filter((cell) => cell.vendor === "turso").map((cell) => cell.surface)))
      .toEqual(new Set(["api", "cli"]));
    expect(new Set(generated.calibration.cells.map((cell) => cell.harness))).toEqual(new Set(["codex", "claude-code"]));
    expect(new Set(generated.calibration.cells.map((cell) => cell.trial))).toEqual(new Set([1]));
    expect(generated.calibration.cells.every((cell) => cell.profile === "medium" && cell.effort === "medium")).toBe(true);
  });

  it("defines the complete 72-cell production Cartesian matrix", () => {
    expect(generated.production.cells).toHaveLength(72);
    const dimensions = generated.production.packs.flatMap((pack) => pack.surfaces.flatMap((surface) =>
      ["codex", "claude-code"].flatMap((harness) => [1, 2, 3].map((trial) =>
        `${pack.vendor}/${surface}/${harness}/trial-${trial}`))));
    expect(generated.production.cells.map((cell) => cell.key)).toEqual(dimensions);
    expect(new Set(dimensions).size).toBe(72);
    expect(generated.production.cells.every((cell) => cell.profile === "high" && cell.effort === "high")).toBe(true);
  });

  it("pins models, harnesses, runtime, providers, reset, and hashes", () => {
    for (const configuration of [generated.calibration, generated.production]) {
      expect(() => ArenaBatchConfigurationSchema.parse(configuration)).not.toThrow();
      expect(configuration.execution).toEqual({ runtime_backend: "pinned-oci", trust_level: "hosted-trusted" });
      expect(configuration.sandbox?.runtime_lock_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(configuration.harnesses.map((pin) => [pin.harness, pin.version_semver])).toEqual([
        ["codex", "0.145.0"],
        ["claude-code", "2.1.217"],
      ]);
      expect(configuration.cells.every((cell) => cell.model === (cell.harness === "codex"
        ? "gpt-5.6-terra" : "claude-sonnet-5"))).toBe(true);
      expect(configuration.cells.every((cell) => cell.reset_provider !== null)).toBe(true);
      expect(configuration.packs.every((pack) => /^[a-f0-9]{64}$/.test(pack.file_hash))).toBe(true);
      expect(configuration.cells.filter((cell) => cell.vendor === "turso" && cell.surface === "cli")
        .every((cell) => cell.provider_pins.some((pin) => pin.kind === "provisioning"
          && pin.id === "ax-arena-turso-cli" && pin.version === "1.0.0"))).toBe(true);
    }
  });

  it("keeps environment names unique and committed files secret-free", () => {
    const environments = generated.production.cells.map((cell) => `trusted-sandbox-${cell.key.replaceAll("/", "-")}`);
    expect(new Set(environments).size).toBe(72);
    for (const path of Object.values(AXARENA_DATABASE_V1_CONFIGURATION_PATHS)) {
      const text = readFileSync(resolve(ROOT, path), "utf8");
      expect(text).not.toMatch(/"(?:credentials|secret_values?|token_values?|api_key_values?)"\s*:/i);
      expect(text).not.toMatch(/(?:sk-ant-|sk-proj-|ghp_|github_pat_|eyJ[a-zA-Z0-9_-]{20,})/);
    }
  });

  it("fails closed when a production dimension or trusted runtime mode is removed", () => {
    const missingCell = structuredClone(generated.production);
    missingCell.cells.pop();
    expect(() => ArenaBatchConfigurationSchema.parse(missingCell)).toThrow(/Cartesian matrix/);

    const nativeRuntime = structuredClone(generated.production);
    nativeRuntime.execution = { runtime_backend: "native", trust_level: "hosted-trusted" };
    expect(() => ArenaBatchConfigurationSchema.parse(nativeRuntime)).toThrow(/hosted-trusted execution/);
  });
});
