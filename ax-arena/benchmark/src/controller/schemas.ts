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
const Semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/).max(256);
const EnvironmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256);
const Names = z.array(EnvironmentName).max(256).superRefine((names, context) => {
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", message: "credential and scope names must be unique" });
  }
});

export const ARENA_BATCH_SCHEMA = "ax.arena-batch/v1" as const;
export const ARENA_BATCH_COMPLETION_SCHEMA = "ax.arena-batch-completion/v1" as const;

const ArenaBatchCellSchema = z.object({
  key: NonBlank,
  vendor: NonBlank,
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
}).strict();

export const ArenaBatchConfigurationSchema = z.object({
  command: z.enum(["daeb-low-pass", "daeb-production-rerun"]),
  suite: z.object({
    name: NonBlank,
    version: z.number().int().positive(),
    file_hash: Sha256,
  }).strict(),
  packs: z.array(z.object({
    vendor: NonBlank,
    file_hash: Sha256,
    standard_set_version: NonBlank,
    surfaces: z.array(Surface).max(4),
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
  }).strict().optional(),
}).strict().superRefine((configuration, context) => {
  const keys = configuration.cells.map((cell) => cell.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["cells"], message: "cell keys must be unique" });
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
  const needsTursoCli = configuration.cells.some((cell) => cell.vendor === "turso" && cell.surface === "cli");
  if (needsTursoCli !== Boolean(configuration.turso_cli)) {
    context.addIssue({
      code: "custom",
      path: ["turso_cli"],
      message: "a Turso CLI pin is required exactly when the batch contains Turso CLI cells",
    });
  }
});
export type ArenaBatchConfiguration = z.infer<typeof ArenaBatchConfigurationSchema>;

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
  expected_cells: z.array(NonBlank).min(1).max(16_384),
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

export const ArenaBatchCompletionCellSchema = z.object({
  key: NonBlank,
  record_id: NonBlank,
  record_path: NonBlank,
  record_hash: Sha256,
  cleanup_path: NonBlank,
  cleanup_hash: Sha256,
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
