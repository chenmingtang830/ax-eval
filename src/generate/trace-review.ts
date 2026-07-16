import { z } from "zod";
import { loadOptionalYamlArtifact } from "./artifact-yaml.js";

export const TraceReviewMemoSchema = z.object({
  schema: z.literal("ax.trace-review/v1"),
  benchmark: z.string().min(1),
  generated_at: z.string().datetime(),
  status: z.enum(["pending", "completed"]),
  sample_size: z.number().int().positive(),
  sample_ids: z.array(z.string().min(1)),
  reviewer: z.string().min(1).optional(),
  reviewed_at: z.string().datetime().optional(),
  commit_sha: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
  findings: z.array(z.string().min(1)),
  summary: z.string().min(1),
}).strict().superRefine((memo, context) => {
  if (new Set(memo.sample_ids).size !== memo.sample_ids.length) {
    context.addIssue({ code: "custom", path: ["sample_ids"], message: "must be unique" });
  }
  if (memo.sample_ids.length > memo.sample_size) {
    context.addIssue({ code: "custom", path: ["sample_ids"], message: "cannot exceed sample_size" });
  }
  if (memo.status !== "completed") return;
  if (!memo.reviewer) context.addIssue({ code: "custom", path: ["reviewer"], message: "required when completed" });
  if (!memo.reviewed_at) context.addIssue({ code: "custom", path: ["reviewed_at"], message: "required when completed" });
  if (!memo.commit_sha) context.addIssue({ code: "custom", path: ["commit_sha"], message: "required when completed" });
  if (memo.sample_ids.length !== memo.sample_size) {
    context.addIssue({
      code: "custom",
      path: ["sample_ids"],
      message: `must contain exactly sample_size (${memo.sample_size}) entries when completed`,
    });
  }
});

export type TraceReviewMemo = z.infer<typeof TraceReviewMemoSchema>;

export function loadTraceReviewPath(path: string): TraceReviewMemo | null {
  return loadOptionalYamlArtifact(path, TraceReviewMemoSchema, "trace review memo");
}
