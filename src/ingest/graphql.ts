/**
 * Best-effort GraphQL ingest, for coverage/provenance — the GraphQL analogue of
 * the OpenAPI ingest. Provides two levels of detail:
 *
 * 1. Basic (`ingestGraphql`): catalogue of object types + mutations. Used by the
 *    existing pack/report pipeline. Oracles at this level are HAND-AUTHORED.
 *
 * 2. Detailed (`ingestGraphqlDetailed`): richer data including mutation return
 *    types, query fields with args, and nested type fields. Used by
 *    `src/generate/graphql-pack.ts` to deterministically derive first-pass
 *    read-back oracles from common id/ids query conventions. A human still
 *    approves the pack through the review gate before anything runs.
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

class GraphqlIngestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
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
// Detailed introspection — used by graphql-pack.ts for oracle derivation
// ---------------------------------------------------------------------------

/** Expanded introspection query that also fetches field types and arg names,
 *  giving the pack generator enough context to write a read-back query. */
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
        args {
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
        }
      }
      inputFields {
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
      }
    }
  }
}`.trim();

const SCHEMA_CATALOG_QUERY = `
query AxSchemaCatalog {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind
      name
    }
  }
}`.trim();

const TYPE_DETAIL_SELECTION = `
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
  args {
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
  }
}
inputFields {
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
}`.trim();

const TYPE_BATCH_SIZE = 24;

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
  argDetails?: Array<{ name: string; typeName: string }>;
}

/** All fields of a named object type. */
export interface ObjectTypeDetail {
  name: string;
  fields: FieldDetail[];
}

/** All fields of a named GraphQL input object type. */
export interface InputObjectTypeDetail {
  name: string;
  fields: Array<{ name: string; typeName: string }>;
}

/** Richer ingestion result that includes per-mutation return types, query type
 *  fields, and full field listings per object type — the data needed to derive
 *  GraphQL read-back oracles. */
export interface IngestedGraphqlRich extends IngestedGraphql {
  mutationDetails: Array<{ name: string; returnTypeName: string; args: string[]; argDetails?: Array<{ name: string; typeName: string }> }>;
  queryTypeFields: FieldDetail[];
  typeDetails: ObjectTypeDetail[];
  inputTypeDetails: InputObjectTypeDetail[];
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

  type RawArg = { name: string; type?: TypeRef };
  type RawInputField = { name: string; type?: TypeRef };
  type RawField = { name: string; type?: TypeRef; args?: RawArg[] };
  type RawType = { kind: string; name: string; fields?: RawField[] | null; inputFields?: RawInputField[] | null };

  const typeMap = new Map<string, FieldDetail[]>();
  for (const t of types as RawType[]) {
    if (t.kind !== "OBJECT" || !t.name || t.name.startsWith("__")) continue;
    typeMap.set(
      t.name,
      (t.fields ?? []).map((f) => ({
        name: f.name,
        typeName: f.type ? unwrapTypeName(f.type) : "Unknown",
        args: (f.args ?? []).map((a) => a.name),
        argDetails: (f.args ?? []).map((a) => ({
          name: a.name,
          typeName: a.type ? unwrapTypeName(a.type) : "Unknown",
        })),
      })),
    );
  }

  const inputTypeDetails: InputObjectTypeDetail[] = (types as RawType[])
    .filter((t) => t.kind === "INPUT_OBJECT" && !!t.name)
    .map((t) => ({
      name: t.name,
      fields: (t.inputFields ?? []).map((f) => ({
        name: f.name,
        typeName: f.type ? unwrapTypeName(f.type) : "Unknown",
      })),
    }));

  const mutType = (types as RawType[]).find((t) => t.name === base.mutationType);
  const mutationDetails = (mutType?.fields ?? []).map((f) => ({
    name: f.name,
    returnTypeName: f.type ? unwrapTypeName(f.type) : "Unknown",
    args: (f.args ?? []).map((a) => a.name),
    argDetails: (f.args ?? []).map((a) => ({
      name: a.name,
      typeName: a.type ? unwrapTypeName(a.type) : "Unknown",
    })),
  }));

  const qType = (types as RawType[]).find((t) => t.name === base.queryType);
  const queryTypeFields: FieldDetail[] = (qType?.fields ?? []).map((f) => ({
    name: f.name,
    typeName: f.type ? unwrapTypeName(f.type) : "Unknown",
    args: (f.args ?? []).map((a) => a.name),
    argDetails: (f.args ?? []).map((a) => ({
      name: a.name,
      typeName: a.type ? unwrapTypeName(a.type) : "Unknown",
    })),
  }));

  const typeDetails: ObjectTypeDetail[] = [...typeMap.entries()].map(([name, fields]) => ({
    name,
    fields,
  }));

  return { ...base, mutationDetails, queryTypeFields, typeDetails, inputTypeDetails };
}

function summarizeGraphqlBody(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 240);
  try {
    return JSON.stringify(body).slice(0, 240);
  } catch {
    return String(body).slice(0, 240);
  }
}

function isComplexityError(error: unknown): boolean {
  if (!(error instanceof GraphqlIngestError)) return false;
  const summary = `${error.message} ${summarizeGraphqlBody(error.body)}`.toLowerCase();
  return error.status === 400 && summary.includes("complex");
}

async function fetchGraphqlJson(endpoint: string, query: string, signal: AbortSignal): Promise<Json> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query }),
    signal,
  });
  const raw = await res.text();
  let body: unknown = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = raw;
  }
  if (!res.ok) {
    throw new GraphqlIngestError(`introspection HTTP ${res.status}: ${summarizeGraphqlBody(body)}`, res.status, body);
  }
  const errors = Array.isArray((body as Json | undefined)?.errors) ? ((body as Json).errors as unknown[]) : [];
  if (errors.length) {
    throw new GraphqlIngestError(`introspection GraphQL errors: ${summarizeGraphqlBody(errors)}`, res.status, body);
  }
  if (!body || typeof body !== "object") {
    throw new GraphqlIngestError("introspection returned a non-JSON body", res.status, body);
  }
  return body as Json;
}

function buildTypeBatchQuery(typeNames: string[]): string {
  const selections = typeNames
    .map((name, i) => `t${i}: __type(name: ${JSON.stringify(name)}) { ${TYPE_DETAIL_SELECTION} }`)
    .join("\n");
  return `query AxTypeBatch {\n${selections}\n}`;
}

async function fetchDetailedIntrospectionInBatches(endpoint: string, signal: AbortSignal): Promise<Json> {
  const catalog = await fetchGraphqlJson(endpoint, SCHEMA_CATALOG_QUERY, signal);
  const schema = ((catalog.data as Json | undefined)?.__schema as Json | undefined) ?? {};
  const queryType = ((schema.queryType as Json | undefined)?.name as string | undefined) ?? null;
  const mutationType = ((schema.mutationType as Json | undefined)?.name as string | undefined) ?? null;
  const types = Array.isArray(schema.types) ? (schema.types as Array<Record<string, unknown>>) : [];
  const detailNames = types
    .filter((t) => (t.kind === "OBJECT" || t.kind === "INPUT_OBJECT") && typeof t.name === "string" && !t.name.startsWith("__"))
    .map((t) => t.name as string);

  const detailedTypes: Json[] = [];
  for (let i = 0; i < detailNames.length; i += TYPE_BATCH_SIZE) {
    const batch = detailNames.slice(i, i + TYPE_BATCH_SIZE);
    const chunk = await fetchGraphqlJson(endpoint, buildTypeBatchQuery(batch), signal);
    const data = (chunk.data as Json | undefined) ?? {};
    for (let j = 0; j < batch.length; j += 1) {
      const detail = data[`t${j}`];
      if (detail && typeof detail === "object") detailedTypes.push(detail as Json);
    }
  }

  return {
    data: {
      __schema: {
        queryType: { name: queryType },
        mutationType: { name: mutationType },
        types: detailedTypes,
      },
    },
  };
}

/** Like `ingestGraphql` but returns the richer `IngestedGraphqlRich` shape.
 *  SDL inputs fall back to empty rich fields because deterministic generation
 *  needs typed introspection JSON. */
export async function ingestGraphqlDetailed(
  endpointOrSchema: string,
  opts: IngestGraphqlOptions = {},
): Promise<IngestedGraphqlRich> {
  const empty = (base: IngestedGraphql): IngestedGraphqlRich => ({
    ...base,
    mutationDetails: [],
    queryTypeFields: [],
    typeDetails: [],
    inputTypeDetails: [],
  });

  const looksLikeUrl = /^https?:\/\//i.test(endpointOrSchema);
  if (looksLikeUrl && !opts.offline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
    try {
      try {
        const json = await fetchGraphqlJson(endpointOrSchema, DETAILED_INTROSPECTION_QUERY, controller.signal);
        return parseDetailedIntrospectionResult(json, endpointOrSchema);
      } catch (error) {
        if (!isComplexityError(error)) throw error;
        const json = await fetchDetailedIntrospectionInBatches(endpointOrSchema, controller.signal);
        return parseDetailedIntrospectionResult(json, endpointOrSchema);
      }
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
