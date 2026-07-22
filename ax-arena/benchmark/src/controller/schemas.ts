import { createHash } from "node:crypto";
import { z } from "zod";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, canonical(nested)]));
  }
  return value;
}

const BoundedText = z.string().max(4_096);
const NonBlank = BoundedText.refine((value) => /\S/.test(value), "must contain non-whitespace text");
const Namespace = z.string().regex(/^[a-z0-9-]+$/).max(43);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.string().datetime({ offset: false, precision: 3 });
const CleanupPlanSchema = z.object({
  summary: BoundedText,
  resources: z.array(NonBlank).max(100),
}).strict();
const CleanupEvidenceSchema = z.object({
  supported: z.boolean(),
  message: BoundedText,
  deleted: z.array(NonBlank).max(100),
  errors: z.array(BoundedText).max(128),
}).strict();

export const ARENA_CELL_CLEANUP_SCHEMA = "ax.arena-cell-cleanup/v1" as const;
export const ArenaCellCleanupSchema = z.object({
  schema: z.literal(ARENA_CELL_CLEANUP_SCHEMA),
  cell_id: NonBlank,
  record_path: NonBlank,
  record_sha256: Sha256,
  generated_at: Timestamp,
  status: z.enum(["confirmed", "skipped", "unconfirmed"]),
  provider: z.object({ id: NonBlank, version: NonBlank }).strict().optional(),
  namespace: Namespace.optional(),
  plan: CleanupPlanSchema.optional(),
  evidence: CleanupEvidenceSchema.optional(),
  message: BoundedText,
  errors: z.array(BoundedText).max(128),
}).strict().superRefine((cleanup, context) => {
  if (cleanup.status !== "confirmed") return;
  for (const field of ["provider", "namespace", "plan", "evidence"] as const) {
    if (cleanup[field] === undefined) {
      context.addIssue({ code: "custom", path: [field], message: `confirmed cleanup requires ${field}` });
    }
  }
  if (cleanup.errors.length) {
    context.addIssue({ code: "custom", path: ["errors"], message: "confirmed cleanup cannot contain errors" });
  }
  if (!cleanup.plan || !cleanup.evidence) return;
  if (!cleanup.evidence.supported) {
    context.addIssue({ code: "custom", path: ["evidence", "supported"], message: "confirmed cleanup must be supported" });
  }
  if (cleanup.evidence.errors.length) {
    context.addIssue({ code: "custom", path: ["evidence", "errors"], message: "confirmed cleanup evidence cannot contain errors" });
  }
  if (new Set(cleanup.plan.resources).size !== cleanup.plan.resources.length
    || new Set(cleanup.evidence.deleted).size !== cleanup.evidence.deleted.length) {
    context.addIssue({ code: "custom", path: ["evidence", "deleted"], message: "confirmed cleanup resources must be unique" });
  }
  const planned = [...cleanup.plan.resources].sort();
  const deleted = [...cleanup.evidence.deleted].sort();
  if (planned.length !== deleted.length || planned.some((resource, index) => resource !== deleted[index])) {
    context.addIssue({ code: "custom", path: ["evidence", "deleted"], message: "confirmed cleanup evidence must exactly match the plan" });
  }
});
export type ArenaCellCleanupRecord = z.infer<typeof ArenaCellCleanupSchema>;

const SourceSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Surface = z.enum(["api", "cli", "sdk", "mcp"]);
const Harness = z.enum(["codex", "claude-code"]);
const ProviderKind = z.enum(["oracle", "provisioning", "health-check", "target-adapter"]);
export const ArenaVendorSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const CellKey = z.string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}\/(?:api|cli|sdk|mcp)\/(?:codex|claude-code)\/trial-[1-9]\d*$/)
  .max(256);
const ReportPath = z.string()
  .regex(/^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._/-]+$/)
  .max(4_096);
const Semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/).max(256);
const EnvironmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256);
const Names = z.array(EnvironmentName).max(256).superRefine((names, context) => {
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", message: "credential and scope names must be unique" });
  }
});
const ProviderText = NonBlank.refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "provider identity cannot contain control characters");
const ProviderIdentitySchema = z.object({ id: ProviderText, version: ProviderText }).strict();
const ProviderPinSchema = ProviderIdentitySchema.extend({ kind: ProviderKind }).strict();
const ProviderPinsSchema = z.array(ProviderPinSchema).max(128).superRefine((pins, context) => {
  const identities = pins.map((pin) => JSON.stringify([pin.kind, pin.id, pin.version]));
  if (new Set(identities).size !== identities.length) {
    context.addIssue({ code: "custom", message: "provider pins must be unique" });
  }
  if (identities.some((identity, index) => index > 0 && identities[index - 1]! > identity)) {
    context.addIssue({ code: "custom", message: "provider pins must be canonically sorted" });
  }
});
const TrustedSandboxSchema = z.object({
  kind: z.literal("bubblewrap"),
  policy_version: z.literal("ax.arena-bubblewrap/v2"),
  runtime_lock_sha256: Sha256,
  sysroot: z.literal("/opt/ax-arena-runtime/rootfs"),
  executable: NonBlank.refine((value) => value.startsWith("/"), "sandbox executable must be absolute"),
  executable_sha256: Sha256,
  runtime_roots: z.tuple([z.literal("/usr"), z.literal("/opt/ax-arena-tools")]),
}).strict();

export const ARENA_BATCH_SCHEMA = "ax.arena-batch/v1" as const;
export const ARENA_BATCH_COMPLETION_SCHEMA = "ax.arena-batch-completion/v1" as const;
export const ArenaRuntimeBackendSchema = z.enum(["native", "pinned-oci"]);
export const ArenaTrustLevelSchema = z.enum(["local", "hosted-trusted"]);
export const ArenaExecutionModeSchema = z.object({
  runtime_backend: ArenaRuntimeBackendSchema,
  trust_level: ArenaTrustLevelSchema,
}).strict().superRefine((mode, context) => {
  if (mode.trust_level === "hosted-trusted" && mode.runtime_backend !== "pinned-oci") {
    context.addIssue({
      code: "custom",
      path: ["runtime_backend"],
      message: "hosted-trusted execution requires the pinned-oci runtime backend",
    });
  }
});
export type ArenaExecutionMode = z.infer<typeof ArenaExecutionModeSchema>;

const ArenaBatchCellSchema = z.object({
  key: CellKey,
  vendor: ArenaVendorSchema,
  surface: Surface,
  harness: Harness,
  profile: z.enum(["medium", "high"]),
  effort: z.enum(["medium", "high"]),
  model: NonBlank,
  trial: z.number().int().positive(),
  host_credential_names: Names,
  verification_credential_names: Names,
  reset_credential_names: Names,
  sandbox_scope_names: Names,
  provider_pins: ProviderPinsSchema,
  reset_provider: ProviderIdentitySchema.nullable(),
}).strict();

export const ArenaBatchConfigurationSchema = z.object({
  command: z.enum(["daeb-low-pass", "daeb-production-rerun"]),
  execution: ArenaExecutionModeSchema.optional(),
  suite: z.object({
    name: NonBlank,
    version: z.number().int().positive(),
    file_hash: Sha256,
  }).strict(),
  packs: z.array(z.object({
    vendor: ArenaVendorSchema,
    file_hash: Sha256,
    standard_set_version: NonBlank,
    surfaces: z.array(Surface).min(1).max(4),
    host_credential_names: Names,
    verification_credential_names: Names,
    reset_credential_names: Names,
    sandbox_scope_names: Names,
  }).strict()).min(1).max(256),
  cells: z.array(ArenaBatchCellSchema).min(1).max(16_384),
  harnesses: z.array(z.object({
    harness: Harness,
    version_raw: NonBlank,
    version_semver: Semver,
  }).strict()).min(1).max(2),
  reset_required: z.boolean(),
  invoke_timeout_seconds: z.number().int().nonnegative(),
  first_action_timeout_seconds: z.number().int().nonnegative(),
  invoke_retries: z.number().int().nonnegative(),
  turso_cli: z.object({
    install_root: NonBlank,
    version: NonBlank,
    sha256: Sha256,
    provisioner: ProviderIdentitySchema,
  }).strict().optional(),
  sandbox: TrustedSandboxSchema.optional(),
}).strict().superRefine((configuration, context) => {
  const execution = configuration.execution ?? { runtime_backend: "native", trust_level: "local" };
  if (execution.runtime_backend === "pinned-oci" && !configuration.sandbox) {
    context.addIssue({ code: "custom", path: ["sandbox"], message: "pinned-oci execution requires an immutable sandbox configuration" });
  }
  if (execution.runtime_backend === "native" && configuration.sandbox) {
    context.addIssue({ code: "custom", path: ["sandbox"], message: "native execution cannot claim pinned OCI sandbox provenance" });
  }
  const keys = configuration.cells.map((cell) => cell.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["cells"], message: "cell keys must be unique" });
  }
  for (const [index, cell] of configuration.cells.entries()) {
    const expectedKey = `${cell.vendor}/${cell.surface}/${cell.harness}/trial-${cell.trial}`;
    if (cell.key !== expectedKey) {
      context.addIssue({ code: "custom", path: ["cells", index, "key"], message: `cell key must equal ${expectedKey}` });
    }
  }
  const cohorts = new Map<string, typeof configuration.cells>();
  for (const cell of configuration.cells) {
    const key = `${cell.vendor}/${cell.surface}/${cell.harness}`;
    cohorts.set(key, [...(cohorts.get(key) ?? []), cell]);
  }
  for (const [key, cells] of cohorts) {
    const signatures = new Set(cells.map((cell) => `${cell.model}\0${cell.profile}\0${cell.effort}`));
    const trials = cells.map((cell) => cell.trial).sort((left, right) => left - right);
    if (signatures.size !== 1
      || new Set(trials).size !== trials.length
      || trials.some((trial, index) => trial !== index + 1)) {
      context.addIssue({
        code: "custom",
        path: ["cells"],
        message: `cohort ${key} must use one model/profile/effort and contiguous unique trials`,
      });
    }
  }
  const vendors = configuration.packs.map((pack) => pack.vendor);
  if (new Set(vendors).size !== vendors.length) {
    context.addIssue({ code: "custom", path: ["packs"], message: "pack vendors must be unique" });
  }
  for (const [index, pack] of configuration.packs.entries()) {
    if (new Set(pack.surfaces).size !== pack.surfaces.length) {
      context.addIssue({ code: "custom", path: ["packs", index, "surfaces"], message: "pack surfaces must be unique" });
    }
    const cells = configuration.cells.filter((cell) => cell.vendor === pack.vendor);
    if (!cells.length) {
      context.addIssue({ code: "custom", path: ["packs", index], message: "every configured pack must have cells" });
      continue;
    }
    const union = (select: (cell: (typeof cells)[number]) => string[]) =>
      [...new Set(cells.flatMap(select))].sort().join("\0");
    const same = (left: readonly string[], right: readonly string[]) =>
      [...left].sort().join("\0") === [...right].sort().join("\0");
    if (!same(pack.surfaces, [...new Set(cells.map((cell) => cell.surface))])
      || union((cell) => cell.host_credential_names) !== [...pack.host_credential_names].sort().join("\0")
      || union((cell) => cell.verification_credential_names) !== [...pack.verification_credential_names].sort().join("\0")
      || union((cell) => cell.reset_credential_names) !== [...pack.reset_credential_names].sort().join("\0")
      || union((cell) => cell.sandbox_scope_names) !== [...pack.sandbox_scope_names].sort().join("\0")) {
      context.addIssue({
        code: "custom",
        path: ["packs", index],
        message: "pack surfaces and credential partitions must equal the union of its cells",
      });
    }
  }
  const packVendors = new Set(configuration.packs.map((pack) => pack.vendor));
  if (configuration.cells.some((cell) => !packVendors.has(cell.vendor))) {
    context.addIssue({ code: "custom", path: ["cells"], message: "every cell vendor must have one configured pack" });
  }
  const pinnedHarnesses = configuration.harnesses.map((pin) => pin.harness);
  const usedHarnesses = [...new Set(configuration.cells.map((cell) => cell.harness))].sort();
  if (new Set(pinnedHarnesses).size !== pinnedHarnesses.length
    || [...pinnedHarnesses].sort().join("\0") !== usedHarnesses.join("\0")) {
    context.addIssue({
      code: "custom",
      path: ["harnesses"],
      message: "harness pins must uniquely and exactly cover the configured cell harnesses",
    });
  }
  const exactHarnesses = [...pinnedHarnesses].sort().join("\0") === "claude-code\0codex";
  if (!exactHarnesses) {
    context.addIssue({
      code: "custom",
      path: ["harnesses"],
      message: "DAEB batches require both Codex and Claude Code harness pins",
    });
  }
  const trials = [...new Set(configuration.cells.map((cell) => cell.trial))].sort((left, right) => left - right);
  if (trials.some((trial, index) => trial !== index + 1)) {
    context.addIssue({ code: "custom", path: ["cells"], message: "batch trials must be contiguous from 1" });
  }
  const dimensions = new Map<string, number>();
  for (const [index, cell] of configuration.cells.entries()) {
    const canonicalKey = `${cell.vendor}/${cell.surface}/${cell.harness}/trial-${cell.trial}`;
    if (cell.key !== canonicalKey) {
      context.addIssue({ code: "custom", path: ["cells", index, "key"], message: `cell key must equal ${canonicalKey}` });
    }
    const dimension = JSON.stringify([cell.vendor, cell.surface, cell.harness, cell.trial]);
    dimensions.set(dimension, (dimensions.get(dimension) ?? 0) + 1);
  }
  for (const [packIndex, pack] of configuration.packs.entries()) {
    for (const surface of pack.surfaces) {
      for (const harness of pinnedHarnesses) {
        for (const trial of trials) {
          const dimension = JSON.stringify([pack.vendor, surface, harness, trial]);
          if (dimensions.get(dimension) !== 1) {
            context.addIssue({
              code: "custom",
              path: ["packs", packIndex, "surfaces"],
              message: "packs, surfaces, harnesses, and trials must form a complete Cartesian matrix",
            });
          }
        }
      }
    }
  }
  for (const harness of pinnedHarnesses) {
    const policies = new Set(configuration.cells
      .filter((cell) => cell.harness === harness)
      .map((cell) => `${cell.profile}\0${cell.effort}\0${cell.model}`));
    if (policies.size !== 1) {
      context.addIssue({
        code: "custom",
        path: ["cells"],
        message: `all ${harness} cells must use one profile, effort, and model policy`,
      });
    }
  }
  if (configuration.reset_required && configuration.cells.some((cell) => cell.reset_provider === null)) {
    context.addIssue({ code: "custom", path: ["cells"], message: "reset-required batches must pin every reset provider" });
  }
  if (configuration.command === "daeb-production-rerun") {
    const exactTrials = JSON.stringify(trials) === "[1,2,3]";
    const canonicalPolicy = configuration.cells.every((cell) => cell.profile === "high"
      && cell.effort === "high"
      && cell.model === (cell.harness === "codex" ? "gpt-5.6-terra" : "claude-sonnet-5"));
    const scopedSurfaces = configuration.packs.every((pack) =>
      pack.surfaces.every((surface) => surface === "api" || surface === "cli"));
    if (!exactHarnesses || !exactTrials || !configuration.reset_required || !canonicalPolicy || !scopedSurfaces) {
      context.addIssue({
        code: "custom",
        path: ["command"],
        message: "production reruns require both canonical harnesses/models, high effort, three trials, reset, and API/CLI scope",
      });
    }
  } else {
    const lowPassPolicy = JSON.stringify(trials) === "[1]"
      && configuration.cells.every((cell) => cell.profile === "medium" && cell.effort === "medium");
    if (!lowPassPolicy) {
      context.addIssue({
        code: "custom",
        path: ["command"],
        message: "low-pass batches require one medium-profile, medium-effort trial per matrix cell",
      });
    }
  }
  const needsTursoCli = configuration.cells.some((cell) => cell.vendor === "turso" && cell.surface === "cli");
  if (needsTursoCli !== Boolean(configuration.turso_cli)) {
    context.addIssue({
      code: "custom",
      path: ["turso_cli"],
      message: "a Turso CLI pin is required exactly when the batch contains Turso CLI cells",
    });
  }
  if (configuration.turso_cli) {
    for (const [index, cell] of configuration.cells.entries()) {
      if (cell.vendor !== "turso" || cell.surface !== "cli") continue;
      const expected = configuration.turso_cli.provisioner;
      if (!cell.provider_pins.some((pin) => pin.kind === "provisioning"
        && pin.id === expected.id && pin.version === expected.version)) {
        context.addIssue({
          code: "custom",
          path: ["cells", index, "provider_pins"],
          message: "Turso CLI cells must pin the configured provisioner identity and version",
        });
      }
    }
  }
});
export type ArenaBatchConfiguration = z.infer<typeof ArenaBatchConfigurationSchema>;

export function arenaExecutionMode(configuration: ArenaBatchConfiguration): ArenaExecutionMode {
  return configuration.execution
    ? ArenaExecutionModeSchema.parse(configuration.execution)
    : { runtime_backend: "native", trust_level: "local" };
}

/** Mode eligibility only. Publication must also verify the detached OIDC attestation chain. */
export function isPublicationEligibleExecutionMode(mode: ArenaExecutionMode): boolean {
  const parsed = ArenaExecutionModeSchema.parse(mode);
  return parsed.runtime_backend === "pinned-oci" && parsed.trust_level === "hosted-trusted";
}

export function arenaBatchConfigurationHash(configuration: ArenaBatchConfiguration): string {
  const parsed = ArenaBatchConfigurationSchema.parse(configuration);
  return createHash("sha256").update(JSON.stringify(canonical(parsed))).digest("hex");
}

export const ArenaBatchManifestSchema = z.object({
  schema: z.literal(ARENA_BATCH_SCHEMA),
  batch_id: NonBlank,
  source_commit_sha: SourceSha,
  created_at: Timestamp,
  configuration_hash: Sha256,
  configuration: ArenaBatchConfigurationSchema,
  expected_cells: z.array(CellKey).min(1).max(16_384),
}).strict().superRefine((manifest, context) => {
  const computedHash = arenaBatchConfigurationHash(manifest.configuration);
  if (manifest.configuration_hash !== computedHash) {
    context.addIssue({
      code: "custom",
      path: ["configuration_hash"],
      message: `configuration hash must equal ${computedHash}`,
    });
  }
  const expected = manifest.configuration.cells.map((cell) => cell.key);
  if (manifest.expected_cells.length !== expected.length
    || manifest.expected_cells.some((key, index) => key !== expected[index])) {
    context.addIssue({
      code: "custom",
      path: ["expected_cells"],
      message: "expected cells must exactly match the ordered configuration cell keys",
    });
  }
});
export type ArenaBatchManifest = z.infer<typeof ArenaBatchManifestSchema>;

const ArtifactSealSchema = z.object({
  name: z.enum(["results", "trace", "transcript", "invoke_metadata"]),
  path: NonBlank,
  sha256: Sha256,
}).strict();

export const ArenaBatchCompletionCellSchema = z.object({
  key: CellKey,
  record_id: NonBlank,
  record_path: NonBlank,
  record_hash: Sha256,
  cleanup_path: NonBlank,
  cleanup_hash: Sha256,
  artifacts: z.array(ArtifactSealSchema).length(4).superRefine((artifacts, context) => {
    const names = artifacts.map((artifact) => artifact.name);
    const expected = ["invoke_metadata", "results", "trace", "transcript"];
    if (names.some((name, index) => name !== expected[index])) {
      context.addIssue({ code: "custom", message: "artifact seals must contain every artifact in canonical order" });
    }
  }),
  harness: Harness,
  requested_model: NonBlank,
  actual_model: NonBlank,
  harness_version_raw: NonBlank,
  harness_version_semver: Semver,
  status: z.literal("completed"),
  cleanup_status: z.enum(["confirmed", "skipped"]),
}).strict();
export type ArenaBatchCompletionCell = z.infer<typeof ArenaBatchCompletionCellSchema>;

export const ArenaBatchCompletionSchema = z.object({
  schema: z.literal(ARENA_BATCH_COMPLETION_SCHEMA),
  batch_id: NonBlank,
  source_commit_sha: SourceSha,
  configuration_hash: Sha256,
  completed_at: Timestamp,
  cells: z.array(ArenaBatchCompletionCellSchema).min(1).max(16_384),
}).strict();
export type ArenaBatchCompletion = z.infer<typeof ArenaBatchCompletionSchema>;

export const ARENA_RUNTIME_REPORT_SCHEMA = "ax.arena-runtime-report/v1" as const;
export const ArenaRuntimeReportSchema = z.object({
  schema: z.literal(ARENA_RUNTIME_REPORT_SCHEMA),
  batch_id: NonBlank,
  configuration_hash: Sha256,
  generated_at: Timestamp,
  surface_reports: z.array(z.object({
    vendor: ArenaVendorSchema,
    surface: Surface,
    snapshot_path: ReportPath,
    html_path: ReportPath,
    failure_review_path: ReportPath,
  }).strict()).min(1).max(1_024),
  aggregates: z.array(z.object({
    vendor: ArenaVendorSchema,
    surface: Surface,
    harness: Harness,
    trial_count: z.number().int().positive(),
    aggregate_record_path: ReportPath,
    trial_manifest_path: ReportPath,
  }).strict()).min(1).max(2_048),
}).strict();
export type ArenaRuntimeReport = z.infer<typeof ArenaRuntimeReportSchema>;
