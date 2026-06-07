/**
 * Best-effort GraphQL ingest, for coverage/provenance — the GraphQL analogue of
 * the OpenAPI ingest. Provides two levels of detail:
 *
 * 1. Basic (`ingestGraphql`): catalogue of object types + mutations. Used by the
 *    existing pack/report pipeline. Oracles at this level are HAND-AUTHORED.
 *
 * 2. Detailed (`ingestGraphqlDetailed`): richer data including mutation return
 *    types, query fields with args, and nested type fields. Used by
 *    `src/generate/graphql-oracle.ts` to give an LLM enough context to
 *    synthesize a read-back oracle automatically (LLM drafts it; a human still
 *    approves it through the review gate before anything runs).
 *
 * Input may be: a live endpoint URL (we POST the introspection query),
 * a path to a saved introspection JSON or SDL file, or a raw introspection-JSON
 * / SDL string.
 */
import { existsSync, readFileSync } from "node:fs";

/** The standard GraphQL introspection query (trimmed to what we surface). */
export const INTROSPECTION_QUERY = `
query AxIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind
      name
      fields(includeDeprecated: true) { name }
    }
  }
}`.trim();

export interface GraphqlMutation {
  name: string;
  /** Heuristic: a create-style mutation (e.g. issueCreate, create_item). */
  isCreate: boolean;
}

export interface IngestedGraphql {
  source: string;
  /** "introspection" or "sdl" — how the schema was parsed. */
  format: "introspection" | "sdl";
  queryType: string | null;
  mutationType: string | null;
  /** Non-introspection OBJECT type names. */
  objectTypes: string[];
  mutations: GraphqlMutation[];
  /** The subset of `mutations` that look create-style. */
  createMutations: string[];
}

export interface IngestGraphqlOptions {
  offline?: boolean;
  timeoutMs?: number;
}

/** A mutation field name that looks like a resource create. */
function isCreateMutation(name: string): boolean {
  return /create/i.test(name) || /(^add|^new)[A-Z_]/.test(name);
}

type Json = Record<string, unknown>;

interface IntrospectionField {
  name?: string;
}
interface IntrospectionType {
  kind?: string;
  name?: string;
  fields?: IntrospectionField[] | null;
}

/** Parse an introspection result (`{ data: { __schema } }` or `{ __schema }`). */
function parseIntrospection(root: Json, source: string): IngestedGraphql {
  const data = (root.data as Json | undefined) ?? root;
  const schema = data.__schema as Json | undefined;
  if (!schema) throw new Error("introspection JSON has no __schema");
  const queryType = ((schema.queryType as Json | undefined)?.name as string | undefined) ?? null;
  const mutationType = ((schema.mutationType as Json | undefined)?.name as string | undefined) ?? null;
  const types = (schema.types as IntrospectionType[] | undefined) ?? [];

  const objectTypes = types
    .filter((t) => t.kind === "OBJECT" && typeof t.name === "string" && !t.name.startsWith("__"))
    .map((t) => t.name as string)
    .sort();

  const mutationObj = mutationType ? types.find((t) => t.name === mutationType) : undefined;
  const mutations: GraphqlMutation[] = (mutationObj?.fields ?? [])
    .map((f) => f.name)
    .filter((n): n is string => typeof n === "string")
    .map((name) => ({ name, isCreate: isCreateMutation(name) }));

  return {
    source,
    format: "introspection",
    queryType,
    mutationType,
    objectTypes,
    mutations,
    createMutations: mutations.filter((m) => m.isCreate).map((m) => m.name),
  };
}

/** Light SDL parse (regex): object type names + the Mutation type's fields. */
function parseSdl(text: string, source: string): IngestedGraphql {
  const reserved = new Set(["Query", "Mutation", "Subscription"]);
  const objectTypes = [...text.matchAll(/\btype\s+(\w+)/g)]
    .map((m) => m[1]!)
    .filter((n) => !reserved.has(n) && !n.startsWith("__"));

  // Extract the body of `type Mutation { ... }` and pull leading field names.
  const block = text.match(/\btype\s+Mutation\s*\{([\s\S]*?)\}/);
  const mutationNames: string[] = [];
  if (block) {
    for (const line of block[1]!.split("\n")) {
      const m = line.trim().match(/^(\w+)\s*[(:]/);
      if (m) mutationNames.push(m[1]!);
    }
  }
  const mutations: GraphqlMutation[] = mutationNames.map((name) => ({ name, isCreate: isCreateMutation(name) }));

  return {
    source,
    format: "sdl",
    queryType: /\btype\s+Query\b/.test(text) ? "Query" : null,
    mutationType: block ? "Mutation" : null,
    objectTypes: [...new Set(objectTypes)].sort(),
    mutations,
    createMutations: mutations.filter((m) => m.isCreate).map((m) => m.name),
  };
}

/** Parse already-fetched/loaded schema text (introspection JSON or SDL). */
export function parseGraphqlSchema(text: string, source = "graphql"): IngestedGraphql {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return parseIntrospection(JSON.parse(trimmed) as Json, source);
    } catch (err) {
      // Fall through to SDL only if it wasn't valid introspection JSON.
      if (err instanceof SyntaxError) return parseSdl(trimmed, source);
      throw err;
    }
  }
  return parseSdl(trimmed, source);
}

/**
 * Ingest a GraphQL schema from an endpoint URL, a saved introspection/SDL file,
 * or a raw schema string. Live endpoints are POSTed the introspection query.
 */
export async function ingestGraphql(
  endpointOrSchema: string,
  opts: IngestGraphqlOptions = {},
): Promise<IngestedGraphql> {
  const looksLikeUrl = /^https?:\/\//i.test(endpointOrSchema);
  if (looksLikeUrl && !opts.offline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
    try {
      const res = await fetch(endpointOrSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: INTROSPECTION_QUERY }),
        signal: controller.signal,
      });
      const json = (await res.json()) as Json;
      if (!res.ok) throw new Error(`introspection HTTP ${res.status}`);
      return parseIntrospection(json, endpointOrSchema);
    } finally {
      clearTimeout(timer);
    }
  }
  if (existsSync(endpointOrSchema)) {
    return parseGraphqlSchema(readFileSync(endpointOrSchema, "utf8"), `file:${endpointOrSchema}`);
  }
  // Treat the argument itself as schema text (introspection JSON or SDL).
  return parseGraphqlSchema(endpointOrSchema, "inline");
}

// ---------------------------------------------------------------------------
// Detailed introspection — used by graphql-oracle.ts for LLM oracle synthesis
// ---------------------------------------------------------------------------

/** Expanded introspection query that also fetches field types and arg names,
 *  giving the oracle synthesizer enough context to write a read-back query. */
export const DETAILED_INTROSPECTION_QUERY = `
query AxDetailedIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind
      name
      fields(includeDeprecated: false) {
        name
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType { kind name }
            }
          }
        }
        args { name }
      }
    }
  }
}`.trim();

/** A GraphQL type reference, potentially wrapped in NON_NULL / LIST. */
export interface TypeRef {
  kind: string;
  name?: string | null;
  ofType?: TypeRef | null;
}

/** A single field with its unwrapped type name and arg names. */
export interface FieldDetail {
  name: string;
  typeName: string;
  args: string[];
}

/** All fields of a named object type. */
export interface ObjectTypeDetail {
  name: string;
  fields: FieldDetail[];
}

/** Richer ingestion result that includes per-mutation return types, query type
 *  fields, and full field listings per object type — the data needed to give an
 *  LLM enough context to synthesize a GraphQL read-back oracle. */
export interface IngestedGraphqlRich extends IngestedGraphql {
  mutationDetails: Array<{ name: string; returnTypeName: string; args: string[] }>;
  queryTypeFields: FieldDetail[];
  typeDetails: ObjectTypeDetail[];
}

/** Unwrap NON_NULL / LIST wrappers to get the named type. */
function unwrapTypeName(type: TypeRef): string {
  if (type.name) return type.name;
  if (type.ofType) return unwrapTypeName(type.ofType);
  return "Unknown";
}

function parseDetailedIntrospectionResult(root: Json, source: string): IngestedGraphqlRich {
  const base = parseIntrospection(root, source);
  const data = (root.data as Json | undefined) ?? root;
  const schema = data.__schema as Json;
  const types = (schema.types as Array<Record<string, unknown>>) ?? [];

  type RawField = { name: string; type?: TypeRef; args?: Array<{ name: string }> };
  type RawType = { kind: string; name: string; fields?: RawField[] | null };

  const typeMap = new Map<string, FieldDetail[]>();
  for (const t of types as RawType[]) {
    if (t.kind !== "OBJECT" || !t.name || t.name.startsWith("__")) continue;
    typeMap.set(
      t.name,
      (t.fields ?? []).map((f) => ({
        name: f.name,
        typeName: f.type ? unwrapTypeName(f.type) : "Unknown",
        args: (f.args ?? []).map((a) => a.name),
      })),
    );
  }

  const mutType = (types as RawType[]).find((t) => t.name === base.mutationType);
  const mutationDetails = (mutType?.fields ?? []).map((f) => ({
    name: f.name,
    returnTypeName: f.type ? unwrapTypeName(f.type) : "Unknown",
    args: (f.args ?? []).map((a) => a.name),
  }));

  const qType = (types as RawType[]).find((t) => t.name === base.queryType);
  const queryTypeFields: FieldDetail[] = (qType?.fields ?? []).map((f) => ({
    name: f.name,
    typeName: f.type ? unwrapTypeName(f.type) : "Unknown",
    args: (f.args ?? []).map((a) => a.name),
  }));

  const typeDetails: ObjectTypeDetail[] = [...typeMap.entries()].map(([name, fields]) => ({
    name,
    fields,
  }));

  return { ...base, mutationDetails, queryTypeFields, typeDetails };
}

/** Like `ingestGraphql` but returns the richer `IngestedGraphqlRich` shape.
 *  Required before calling `synthesizeGraphqlOracle`. SDL inputs fall back to
 *  empty rich fields (the LLM synthesis path requires a live introspection JSON). */
export async function ingestGraphqlDetailed(
  endpointOrSchema: string,
  opts: IngestGraphqlOptions = {},
): Promise<IngestedGraphqlRich> {
  const empty = (base: IngestedGraphql): IngestedGraphqlRich => ({
    ...base,
    mutationDetails: [],
    queryTypeFields: [],
    typeDetails: [],
  });

  const looksLikeUrl = /^https?:\/\//i.test(endpointOrSchema);
  if (looksLikeUrl && !opts.offline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
    try {
      const res = await fetch(endpointOrSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: DETAILED_INTROSPECTION_QUERY }),
        signal: controller.signal,
      });
      const json = (await res.json()) as Json;
      if (!res.ok) throw new Error(`introspection HTTP ${res.status}`);
      return parseDetailedIntrospectionResult(json, endpointOrSchema);
    } finally {
      clearTimeout(timer);
    }
  }
  if (existsSync(endpointOrSchema)) {
    const text = readFileSync(endpointOrSchema, "utf8").trim();
    if (text.startsWith("{")) {
      return parseDetailedIntrospectionResult(JSON.parse(text) as Json, `file:${endpointOrSchema}`);
    }
    return empty(parseSdl(text, `file:${endpointOrSchema}`));
  }
  const trimmed = endpointOrSchema.trim();
  if (trimmed.startsWith("{")) {
    return parseDetailedIntrospectionResult(JSON.parse(trimmed) as Json, "inline");
  }
  return empty(parseSdl(trimmed, "inline"));
}
