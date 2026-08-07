import { createHash } from "node:crypto";
import { z } from "zod";

/** Stable contract for the capabilities visible to an evaluated harness. */
export const EXECUTION_POLICY_SCHEMA = "ax.execution-policy/v1" as const;

export const ExecutionNetworkModeSchema = z.enum(["none", "shared"]);
export const ExecutionToolSchema = z.enum([
  "shell",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "web_search",
  "mcp",
]);

export const ExecutionPolicySchema = z.object({
  schema: z.literal(EXECUTION_POLICY_SCHEMA),
  network: ExecutionNetworkModeSchema,
  tools: z.array(ExecutionToolSchema).min(1).max(16).superRefine((tools, context) => {
    if (new Set(tools).size !== tools.length) {
      context.addIssue({ code: "custom", message: "execution tools must be unique" });
    }
    if (tools.some((tool, index) => index > 0 && tools[index - 1]! > tool)) {
      context.addIssue({ code: "custom", message: "execution tools must be canonically sorted" });
    }
  }),
}).strict().superRefine((policy, context) => {
  if (policy.network === "none" && policy.tools.includes("web_search")) {
    context.addIssue({
      code: "custom",
      path: ["tools"],
      message: "network=none cannot expose web_search",
    });
  }
});

export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

export function executionPolicyHash(policy: ExecutionPolicy): string {
  const parsed = ExecutionPolicySchema.parse(policy);
  return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
}

export function executionPolicyAllows(policy: ExecutionPolicy, tool: z.infer<typeof ExecutionToolSchema>): boolean {
  return ExecutionPolicySchema.parse(policy).tools.includes(tool);
}
