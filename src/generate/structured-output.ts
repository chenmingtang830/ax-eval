import { readFileSync } from "node:fs";
import { parse as yamlParse } from "yaml";

export type StructuredGenerator = (prompt: string) => Promise<string>;

export function generatorFixture(): string | null {
  const path = process.env.AX_EVAL_GENERATOR_FIXTURE?.trim();
  return path ? readFileSync(path, "utf8") : null;
}

export async function runStructuredGenerator(
  prompt: string,
  generate?: StructuredGenerator,
): Promise<string> {
  const fixture = generatorFixture();
  if (fixture !== null) return fixture;
  if (!generate) {
    throw new Error("structured generation requires an injected grounded generator or AX_EVAL_GENERATOR_FIXTURE");
  }
  return generate(prompt);
}

export function parseStructuredOutput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("generator returned empty output");
  const fenced = trimmed.match(/```(?:json|ya?ml)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const parsed = yamlParse(candidate);
    if (parsed && typeof parsed === "object") return parsed;
    throw new Error("generator did not return structured JSON or YAML");
  }
}
