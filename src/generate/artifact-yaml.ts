import { existsSync, readFileSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import { z } from "zod";

export function loadOptionalYamlArtifact<Schema extends z.ZodTypeAny>(
  path: string,
  schema: Schema,
  label: string,
): z.output<Schema> | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = yamlParse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid ${label} at ${path}: malformed YAML`,
      { cause: error },
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid ${label} at ${path}: ${result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ")}`);
  }
  return result.data;
}
