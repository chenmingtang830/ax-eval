/**
 * LLM-assisted GraphQL oracle synthesis.
 *
 * Given a mutation name and a rich schema (from `ingestGraphqlDetailed`), calls
 * Claude to draft a read-back query + assertField. The draft is written into the
 * pack and still goes through the human review gate before anything runs — this
 * automates the authoring step, not the approval step.
 *
 * Usage:
 *   const schema = await ingestGraphqlDetailed("https://api.linear.app/graphql");
 *   const oracle = await synthesizeGraphqlOracle("issueCreate", schema);
 *   // oracle.readQueryTemplate === '{ issue(id: "{gid}") { title } }'
 *   // oracle.assertField        === "issue.title"
 */
import Anthropic from "@anthropic-ai/sdk";
import type { IngestedGraphqlRich } from "../ingest/graphql.js";
import type { OracleSpec } from "../schemas.js";

const SCALAR_TYPES = new Set(["String", "Int", "Float", "Boolean", "ID", "UUID", "DateTime", "Date", "Unknown"]);

/** Build a concise schema summary to pass to the LLM as context. */
function buildSchemaContext(mutationName: string, schema: IngestedGraphqlRich): string {
  const lines: string[] = [];

  const mutation = schema.mutationDetails.find((m) => m.name === mutationName);
  lines.push("## Mutation");
  if (mutation) {
    lines.push(`${mutation.name}(${mutation.args.join(", ")}) → ${mutation.returnTypeName}`);
  } else {
    lines.push(`${mutationName} (return type unknown)`);
  }
  lines.push("");

  if (schema.queryTypeFields.length > 0) {
    lines.push("## Query fields available for read-back");
    for (const f of schema.queryTypeFields.slice(0, 30)) {
      lines.push(`  ${f.name}(${f.args.join(", ")}) → ${f.typeName}`);
    }
    lines.push("");
  }

  // Collect the types relevant to this mutation: the return type + its nested types.
  const returnTypeName = mutation?.returnTypeName ?? "";
  const visited = new Set<string>();

  function collectTypes(typeName: string, depth: number) {
    if (depth > 2 || visited.has(typeName) || SCALAR_TYPES.has(typeName)) return;
    visited.add(typeName);
    const t = schema.typeDetails.find((td) => td.name === typeName);
    if (!t) return;
    for (const f of t.fields) collectTypes(f.typeName, depth + 1);
  }

  if (returnTypeName) collectTypes(returnTypeName, 0);
  // Also include types returned by single-item query fields (likely read-back targets).
  for (const f of schema.queryTypeFields) {
    if (f.args.includes("id") || f.args.includes("ID")) collectTypes(f.typeName, 0);
  }

  if (visited.size > 0) {
    lines.push("## Relevant types");
    for (const typeName of visited) {
      const t = schema.typeDetails.find((td) => td.name === typeName);
      if (!t) continue;
      lines.push(`Type ${typeName}:`);
      for (const f of t.fields.slice(0, 20)) {
        lines.push(`  ${f.name}: ${f.typeName}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are generating a GraphQL read-back oracle for an integration test framework called ax-eval.

The framework runs a mutation (creating a resource), captures the returned id, then independently verifies the result by reading the resource back via a separate query. Your job is to generate that read-back query and specify which field to assert.

Return a JSON object with exactly these fields:
- "readQueryTemplate": a GraphQL query string using {gid} as the id placeholder (e.g. '{ issue(id: "{gid}") { title } }')
- "assertField": a dotted path into the query response data object to assert (e.g. "issue.title")
- "description": a short human-readable description of what this oracle checks

Rules:
- Use {gid} where the resource id goes — the verifier substitutes the real id at runtime
- Prefer asserting a name or title field that proves the resource was created with the right content
- The assertField must be a real path accessible from the readQueryTemplate response
- Keep the query minimal — only select the fields you assert
- Return only valid JSON, no markdown fences, no explanation`;

export interface SynthesizedOracle
  extends Pick<OracleSpec, "readQueryTemplate" | "assertField" | "description"> {
  /** Model that produced this draft, for pack provenance. */
  synthesizedBy: string;
}

/** Call Claude to draft a GraphQL read-back oracle for `mutationName`.
 *
 * @param mutationName  The create-style mutation to generate an oracle for.
 * @param schema        Rich schema from `ingestGraphqlDetailed`.
 * @param apiKey        Anthropic API key (falls back to ANTHROPIC_API_KEY env var).
 * @param model         Model to use (defaults to claude-sonnet-4-6).
 */
export async function synthesizeGraphqlOracle(
  mutationName: string,
  schema: IngestedGraphqlRich,
  apiKey?: string,
  model = "claude-sonnet-4-6",
): Promise<SynthesizedOracle> {
  const client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
  const context = buildSchemaContext(mutationName, schema);

  const response = await client.messages.create({
    model,
    max_tokens: 512,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: context }],
  });

  const raw = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`LLM returned non-JSON oracle response for ${mutationName}:\n${raw}`);
  }

  const readQueryTemplate = parsed.readQueryTemplate;
  const assertField = parsed.assertField;
  if (typeof readQueryTemplate !== "string" || typeof assertField !== "string") {
    throw new Error(
      `LLM oracle response missing required fields for ${mutationName}:\n${raw}`,
    );
  }

  return {
    readQueryTemplate,
    assertField,
    description:
      typeof parsed.description === "string"
        ? parsed.description
        : `read ${mutationName} result back and assert ${assertField}`,
    synthesizedBy: model,
  };
}

/** Synthesize oracles for all create-style mutations in a rich schema.
 *  Returns a map of mutation name → synthesized oracle. */
export async function synthesizeAllCreateOracles(
  schema: IngestedGraphqlRich,
  apiKey?: string,
  model?: string,
): Promise<Map<string, SynthesizedOracle>> {
  const results = new Map<string, SynthesizedOracle>();
  for (const name of schema.createMutations) {
    results.set(name, await synthesizeGraphqlOracle(name, schema, apiKey, model));
  }
  return results;
}
