import { z } from "zod";

const BoundedText = z.string().max(4_096);
const NonBlank = BoundedText.refine((value) => /\S/.test(value), "must contain non-whitespace text");
const Namespace = z.string().regex(/^[a-z0-9-]+$/).max(43);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
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
  generated_at: z.string().datetime(),
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
