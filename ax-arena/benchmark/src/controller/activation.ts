import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadPack, packFileContentHash, type SurfaceId, type TargetPack } from "ax-eval";
import { cellCredentialNames, cellResetCredentialNames, cellVerificationCredentialNames } from "./cell.js";
import { ArenaBatchConfigurationSchema, type ArenaBatchConfiguration } from "./schemas.js";

export const AXARENA_DATABASE_V1_CONFIGURATION_PATHS = Object.freeze({
  calibration: "ax-arena/benchmark/axarena-database/v1/configurations/calibration-supabase-turso.json",
  production: "ax-arena/benchmark/axarena-database/v1/configurations/production.json",
});

const ALL_VENDORS = ["cockroachdb", "insforge", "neon", "nile", "supabase", "turso"] as const;
const CALIBRATION_VENDORS = ["supabase", "turso"] as const;
const SURFACES = ["api", "cli"] as const;
const HARNESSES = ["codex", "claude-code"] as const;

/**
 * The Supabase project data API is PostgREST: it can operate pre-existing
 * relations but cannot create the tables, roles, and policies required by the
 * canonical v1 tasks. Keep that capability mismatch out of the first live
 * calibration rather than publishing a known-impossible API score. The
 * production matrix remains the declared target and must be regenerated only
 * after the Supabase API pack gains an admitted management/provisioning path.
 */
function surfacesFor(mode: "calibration" | "production", vendor: string): readonly SurfaceId[] {
  if (mode === "calibration" && vendor === "supabase") return ["cli"];
  return SURFACES;
}

interface TrustedRuntimeLock {
  schema: "ax.arena-trusted-runtime-lock/v1";
  platform: "linux/amd64";
  harnesses: {
    codex: { version: string; version_output: string };
    claude_code: { version: string; version_output: string };
  };
  bubblewrap: { executable_path: string; executable_sha256: string };
  turso_cli: { version_output: string; executable_path: string; executable_sha256: string };
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runtimeLock(root: string): { value: TrustedRuntimeLock; sha256: string } {
  const path = resolve(root, "ax-arena/benchmark/trusted-runtime/runtime-lock.json");
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes.toString("utf8")) as TrustedRuntimeLock;
  if (value.schema !== "ax.arena-trusted-runtime-lock/v1" || value.platform !== "linux/amd64") {
    throw new Error("activation configurations require the reviewed linux/amd64 trusted runtime lock");
  }
  for (const [label, digest] of [
    ["Bubblewrap executable", value.bubblewrap?.executable_sha256],
    ["Turso executable", value.turso_cli?.executable_sha256],
  ] as const) {
    if (!/^[a-f0-9]{64}$/.test(digest ?? "")) throw new Error(`${label} requires a full SHA-256 pin`);
  }
  return { value, sha256: sha256(bytes) };
}

function providerPins(pack: TargetPack, surface: SurfaceId) {
  const pins: Array<{
    kind: "oracle" | "provisioning" | "health-check" | "target-adapter";
    id: string;
    version: string;
  }> = [];
  if (pack.sql_conn?.dialect === "postgres") {
    pins.push({ kind: "health-check", id: "ax-arena-postgres-health", version: "1.1.0" });
  } else if (pack.name === "turso") {
    pins.push({ kind: "health-check", id: "ax-arena-turso-health", version: "1.0.0" });
  }
  if (pack.tasks.some((task) => task.allowed_surfaces.includes(surface)
    && task.oracles.some((oracle) => typeof oracle.sqlQuery === "string" && oracle.sqlQuery.length > 0))) {
    pins.push({ kind: "oracle", id: "arena-sql", version: "1.0.0" });
  }
  if (pack.name === "turso" && surface === "cli") {
    pins.push({ kind: "provisioning", id: "ax-arena-turso-cli", version: "1.0.0" });
  }
  return pins.sort((left, right) => JSON.stringify([left.kind, left.id, left.version])
    .localeCompare(JSON.stringify([right.kind, right.id, right.version])));
}

function resetProvider(pack: TargetPack) {
  return pack.name === "turso"
    ? { id: "ax-arena-turso-reset", version: "1.0.0" }
    : { id: "ax-arena-postgres-reset", version: "1.0.0" };
}

function sandboxScopeNames(pack: TargetPack): string[] {
  return pack.sandbox_scope.filter((scope) => scope.required).map((scope) => scope.env).sort();
}

function buildConfiguration(root: string, mode: "calibration" | "production"): ArenaBatchConfiguration {
  const vendors = mode === "calibration" ? CALIBRATION_VENDORS : ALL_VENDORS;
  const trials = mode === "calibration" ? [1] : [1, 2, 3];
  const profile = mode === "calibration" ? "medium" : "high";
  const lock = runtimeLock(root);
  const packEntries = vendors.map((vendor) => {
    const path = resolve(root, `ax-arena/benchmark/axarena-database/v1/packs/${vendor}/pack.yaml`);
    return { vendor, path, pack: loadPack(path), surfaces: surfacesFor(mode, vendor) };
  });
  const packs = packEntries.map(({ vendor, path, pack, surfaces }) => ({
    vendor,
    file_hash: packFileContentHash(path),
    standard_set_version: pack.standard_set_version,
    surfaces: [...surfaces],
    host_credential_names: [...new Set(surfaces.flatMap((surface) =>
      HARNESSES.flatMap((harness) => cellCredentialNames(pack, surface, harness, {}))))].sort(),
    verification_credential_names: [...new Set(surfaces.flatMap((surface) =>
      cellVerificationCredentialNames(pack, {}, surface)))].sort(),
    reset_credential_names: cellResetCredentialNames(pack, {}).sort(),
    sandbox_scope_names: sandboxScopeNames(pack),
  }));
  const cells = packEntries.flatMap(({ vendor, pack, surfaces }) => surfaces.flatMap((surface) =>
    HARNESSES.flatMap((harness) => trials.map((trial) => ({
      key: `${vendor}/${surface}/${harness}/trial-${trial}`,
      vendor,
      surface,
      harness,
      profile,
      effort: profile,
      model: harness === "codex" ? "gpt-5.6-terra" : "claude-sonnet-5",
      trial,
      host_credential_names: cellCredentialNames(pack, surface, harness, {}),
      verification_credential_names: cellVerificationCredentialNames(pack, {}, surface),
      reset_credential_names: cellResetCredentialNames(pack, {}).sort(),
      sandbox_scope_names: sandboxScopeNames(pack),
      provider_pins: providerPins(pack, surface),
      reset_provider: resetProvider(pack),
    })))));
  const suitePath = resolve(root, "ax-arena/benchmark/axarena-database/v1/suite.yaml");
  return ArenaBatchConfigurationSchema.parse({
    command: mode === "calibration" ? "axarena-database-low-pass" : "axarena-database-production-rerun",
    execution: { runtime_backend: "pinned-oci", trust_level: "hosted-trusted" },
    suite: { name: "DAEB-1", version: 1, file_hash: sha256(readFileSync(suitePath)) },
    packs,
    cells,
    harnesses: [
      { harness: "codex", version_raw: lock.value.harnesses.codex.version_output, version_semver: lock.value.harnesses.codex.version },
      { harness: "claude-code", version_raw: lock.value.harnesses.claude_code.version_output, version_semver: lock.value.harnesses.claude_code.version },
    ],
    reset_required: true,
    invoke_timeout_seconds: 1_800,
    first_action_timeout_seconds: 180,
    invoke_retries: 0,
    turso_cli: {
      install_root: "/opt/ax-arena-tools/turso",
      version: lock.value.turso_cli.version_output,
      sha256: lock.value.turso_cli.executable_sha256,
      provisioner: { id: "ax-arena-turso-cli", version: "1.0.0" },
    },
    sandbox: {
      kind: "bubblewrap",
      policy_version: "ax.arena-bubblewrap/v2",
      runtime_lock_sha256: lock.sha256,
      sysroot: "/opt/ax-arena-runtime/rootfs",
      executable: lock.value.bubblewrap.executable_path,
      executable_sha256: lock.value.bubblewrap.executable_sha256,
      runtime_roots: ["/usr", "/opt/ax-arena-tools"],
    },
  });
}

export function buildAxArenaDatabaseV1ActivationConfigurations(root: string): Readonly<{
  calibration: ArenaBatchConfiguration;
  production: ArenaBatchConfiguration;
}> {
  return Object.freeze({
    calibration: buildConfiguration(root, "calibration"),
    production: buildConfiguration(root, "production"),
  });
}

export function serializeActivationConfiguration(configuration: ArenaBatchConfiguration): string {
  return `${JSON.stringify(ArenaBatchConfigurationSchema.parse(configuration), null, 2)}\n`;
}
