import { z } from "zod";

export const EVALUATION_CELL_SCHEMA = "ax.evaluation-cell/v1" as const;
export const NORMALIZED_CELL_RECORD_SCHEMA = "ax.normalized-cell-record/v1" as const;

const NonEmptyString = z.string().refine((value) => value.trim().length > 0, "must not be blank");
const EnvNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

export const ReviewedPackReferenceSchema = z.object({
  path: NonEmptyString,
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const EvaluationCellSchema = z.object({
  schema: z.literal(EVALUATION_CELL_SCHEMA),
  cell_id: NonEmptyString,
  batch_id: NonEmptyString,
  evaluation_set_id: NonEmptyString,
  evaluation_set_version: NonEmptyString,
  target_id: NonEmptyString,
  pack: ReviewedPackReferenceSchema,
  surface: z.enum(["api", "cli", "sdk", "mcp"]),
  harness: z.object({
    id: z.enum(["claude-code", "codex"]),
    profile: z.enum(["low", "medium", "high"]),
    model: NonEmptyString,
    effort: z.enum(["low", "medium", "high"]),
  }).strict(),
  trial: z.number().int().positive(),
  source_commit_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  required_credentials: z.array(EnvNameSchema).superRefine((names, context) => {
    const seen = new Set<string>();
    for (const [index, name] of names.entries()) {
      if (seen.has(name)) {
        context.addIssue({ code: "custom", path: [index], message: `duplicate credential name ${name}` });
      }
      seen.add(name);
    }
  }),
  run_context: z.object({
    cwd: NonEmptyString,
    artifact_dir: NonEmptyString,
    invoke_timeout_ms: z.number().int().nonnegative(),
    first_action_timeout_ms: z.number().int().nonnegative(),
    invoke_retries: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export type EvaluationCell = z.infer<typeof EvaluationCellSchema>;
export type ReviewedPackReference = z.infer<typeof ReviewedPackReferenceSchema>;

const OracleResultSchema = z.object({
  type: z.string(),
  passed: z.boolean(),
  detail: z.string(),
}).strict();

export const CellTaskResultSchema = z.object({
  taskId: NonEmptyString,
  difficulty: NonEmptyString,
  profile: NonEmptyString,
  success: z.boolean(),
  oracleResults: z.array(OracleResultSchema),
  error: z.string().nullable(),
  na: z.boolean(),
}).strict();

const NullableNonNegativeNumber = z.number().nonnegative().nullable();

export const ProviderProvenanceSchema = z.object({
  kind: z.enum(["oracle", "provisioning", "health-check", "target-adapter"]),
  id: NonEmptyString,
  version: NonEmptyString,
}).strict();

export const SandboxProvenanceSchema = z.object({
  id: NonEmptyString,
  version: NonEmptyString,
  implementation_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  policy_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const CellDiscoveryReportSchema = z.object({
  ns: NonEmptyString.optional(),
  hops: z.number().int().nonnegative(),
  metrics: z.array(z.object({
    id: z.enum(["official", "canonical", "hops", "misled", "auth", "outcome"]),
    passed: z.boolean(),
    detail: z.string(),
  }).strict()),
}).strict();

/**
 * A one-cell record has its own strict discriminator so existing
 * normalized-result/v1 validators remain unchanged. The legacy
 * standard_set_version alias is retained alongside generic set identity.
 */
export const NormalizedCellRecordSchema = z.object({
  schema: z.literal(NORMALIZED_CELL_RECORD_SCHEMA),
  surface: z.enum(["api", "cli", "sdk", "mcp"]),
  product: NonEmptyString,
  harness: NonEmptyString,
  standard_set_version: NonEmptyString,
  generated_at: z.string().datetime(),
  tasks_total: z.number().int().nonnegative(),
  tasks_passed: z.number().int().nonnegative(),
  pass_at_1: z.number().min(0).max(1),
  pass_at_k: z.number().min(0).max(1),
  attempts: z.number().int().positive(),
  discovery_score: z.number().min(0).max(1).nullable(),
  /** Persist the scored funnel so reports rebuilt from a cell record retain
   * discovery evidence instead of only its scalar score. */
  discovery: CellDiscoveryReportSchema.optional(),
  discovery_source: z.enum(["observed", "self-report"]).optional(),
  content_quality: z.number().min(0).max(1).nullable(),
  profiles: z.array(z.string()),
  best_profile: z.string().nullable(),
  model: z.string().nullable(),
  harness_version_raw: z.string().nullable(),
  harness_version_semver: z.string().nullable(),
  run_batch_id: z.string().nullable(),
  latency_ms: NullableNonNegativeNumber,
  total_duration_ms: NullableNonNegativeNumber,
  tool_call_count: NullableNonNegativeNumber,
  token_usage: z.record(z.number()).nullable(),
  token_cost: NullableNonNegativeNumber,
  cost_usd: NullableNonNegativeNumber,
  tokens_in: NullableNonNegativeNumber,
  tokens_out: NullableNonNegativeNumber,
  validity_status: z.string().nullable(),
  first_action_latency_ms: NullableNonNegativeNumber,
  transcript_event_count: NullableNonNegativeNumber,
  action_occurred: z.boolean().nullable(),
  summary_kind: z.literal("single"),
  record_id: NonEmptyString,
  cell_id: NonEmptyString,
  batch_id: NonEmptyString,
  evaluation_set_id: NonEmptyString,
  evaluation_set_version: NonEmptyString,
  pack_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  source_commit_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  /** Runtime-computed namespace trusted by verification and post-persistence
   * cleanup. Optional only for pre-invocation terminal records and v1 back-compat. */
  execution_namespace: NonEmptyString.optional(),
  target_id: NonEmptyString,
  trial: z.number().int().positive(),
  effort: z.enum(["low", "medium", "high"]),
  requested_model: NonEmptyString,
  started_at: z.string().datetime(),
  completed_at: z.string().datetime(),
  status: z.enum(["completed", "failed", "blocked"]),
  blocked: z.enum([
    "requires-oauth",
    "missing-credential",
    "missing-harness",
    "health-check-failed",
    "invoke-failed",
  ]).optional(),
  error: z.object({
    stage: z.enum(["preflight", "provision", "invoke", "verify"]),
    message: z.string(),
  }).strict().nullable(),
  /** Optional so pre-extension v1 records remain valid byte-for-byte. Reset is
   * recorded in post-persistence cleanup evidence, never in this record. */
  provider_provenance: z.array(ProviderProvenanceSchema).optional(),
  sandbox_provenance: SandboxProvenanceSchema.optional(),
  task_results: z.array(CellTaskResultSchema),
  artifacts: z.object({
    base_dir: NonEmptyString,
    results: NonEmptyString,
    trace: NonEmptyString,
    transcript: NonEmptyString,
    invoke_metadata: NonEmptyString,
  }).strict(),
}).strict();

export type NormalizedCellRecord = z.infer<typeof NormalizedCellRecordSchema>;
