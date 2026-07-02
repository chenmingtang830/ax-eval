import type { SuiteTask } from "./suite.js";
import type { ResolveResult } from "./vendor-resolve.js";

const CONVEX_IDENTIFIER_NOTE = [
  "",
  "Convex-specific database adapter note: Convex table and function identifiers may only use letters, digits,",
  "and underscores, while the canonical DAEB namespace may contain hyphens. When a canonical container or",
  "function name is not a valid Convex identifier, use a deterministic Convex-safe identifier by replacing",
  "non-alphanumeric characters with underscores. Preserve the exact canonical names and marker strings in",
  "record values or verifier query results, and report the requested verifier query path for read-back.",
  "This exception only changes Convex code identifiers; it does not change the canonical outcome marker.",
].join(" ");

export function applyDatabasePackPromptOverride(
  vendor: ResolveResult,
  task: SuiteTask,
  prompt: string,
): string {
  if (vendor.category !== "database") return prompt;
  if (vendor.slug !== "convex") return prompt;
  if (!task.id.startsWith("db-")) return prompt;
  return `${prompt}\n\n${CONVEX_IDENTIFIER_NOTE}`;
}
