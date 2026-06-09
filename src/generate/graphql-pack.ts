/**
 * GraphQL pack generation. Unlike the OpenAPI path, GraphQL schemas do not
 * expose a target-agnostic CRUD graph, so this generator limits itself to the
 * productizable floor: create-style mutations plus deterministic read-back
 * oracles derived from common GraphQL introspection conventions.
 */
import type { IngestedGraphqlRich } from "../ingest/graphql.js";
import type { Auth, OracleSpec, ScopeParam, Task, TargetPack } from "../schemas.js";
import { newRunId, probeValue } from "./pack.js";

export const GRAPHQL_GENERATED_BY = "deterministic@graphql-pack";

export interface GenerateGraphqlPackOptions {
  limit?: number;
  l2Limit?: number;
  l4Limit?: number;
  packName: string;
  version?: string;
  standardSetVersion?: string;
  runId?: string;
  product?: string;
  baseUrl?: string;
  siteUrl?: string;
  docsUrls?: string[];
  authMethod?: string;
  authType?: Auth["type"];
  authEnv?: string;
  authHeader?: string;
  sandboxScope?: ScopeParam[];
  headers?: Record<string, string>;
}

interface DerivedGraphqlOracle {
  createdTypeName: string;
  readQueryTemplate: string;
  assertField: string;
  description: string;
}

interface GraphqlResource {
  mutationName: string;
  label: string;
  typeName: string;
  identityField: string;
  inputFields: Array<{ name: string; typeName: string }>;
  oracle: DerivedGraphqlOracle;
  dependsOn: string[];
  updateMutationName?: string;
}

const IDENTITY_FIELD_PREFERENCE = ["name", "title", "label", "text", "summary"];
const SCALAR_TYPES = new Set(["String", "ID", "UUID", "Int", "Float", "Boolean", "Date", "DateTime"]);

function productSlug(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function deriveAuth(product: string, opts: GenerateGraphqlPackOptions): Auth {
  const type = opts.authType ?? "api-key";
  const env = opts.authEnv ?? (type === "none" ? "" : `${productSlug(product)}_${type === "api-key" ? "API_KEY" : "TOKEN"}`);
  const header = opts.authHeader ?? (type === "none" ? undefined : "Authorization");
  return { type, env, ...(header ? { header } : {}) };
}

function createLabel(mutationName: string): string {
  const cleaned = mutationName
    .replace(/^create[_-]?/i, "")
    .replace(/Create$/i, "")
    .replace(/^add[_-]?/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return cleaned || mutationName;
}

function resourceLabelFromType(typeName: string): string {
  return typeName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
}

function slugPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
}

function indefiniteArticle(label: string): string {
  return /^[aeiou]/i.test(label) ? "an" : "a";
}

function canonicalEndpoint(mutationName: string): string {
  return `mutation ${mutationName}`;
}

function graphqlOracle(oracle: DerivedGraphqlOracle, expected: string): OracleSpec {
  return {
    type: "roundtrip",
    description: oracle.description,
    readQueryTemplate: oracle.readQueryTemplate,
    assertField: oracle.assertField,
    expected,
  };
}

function isRichGraphqlSchema(schema: IngestedGraphqlRich): boolean {
  return Array.isArray(schema.mutationDetails)
    && Array.isArray(schema.queryTypeFields)
    && Array.isArray(schema.typeDetails);
}

export function looksLikeGraphqlIngest(value: unknown): value is IngestedGraphqlRich {
  if (!value || typeof value !== "object") return false;
  const obj = value as Partial<IngestedGraphqlRich>;
  return Array.isArray(obj.mutations) && Array.isArray(obj.createMutations);
}

function objectFields(schema: IngestedGraphqlRich, typeName: string) {
  return schema.typeDetails.find((t) => t.name === typeName)?.fields ?? [];
}

function inputObjectFields(schema: IngestedGraphqlRich, typeName: string) {
  return schema.inputTypeDetails.find((t) => t.name === typeName)?.fields ?? [];
}

function identityField(schema: IngestedGraphqlRich, typeName: string): string | null {
  const fields = objectFields(schema, typeName);
  for (const preferred of IDENTITY_FIELD_PREFERENCE) {
    if (fields.some((f) => f.name === preferred)) return preferred;
  }
  return fields.find((f) => SCALAR_TYPES.has(f.typeName))?.name ?? null;
}

function mutationInputFields(schema: IngestedGraphqlRich, mutationName: string): Array<{ name: string; typeName: string }> {
  const mutation = schema.mutationDetails.find((m) => m.name === mutationName);
  const args = mutation?.argDetails ?? mutation?.args.map((name) => ({ name, typeName: "Unknown" })) ?? [];
  const out: Array<{ name: string; typeName: string }> = [...args];
  for (const arg of args) {
    const nested = inputObjectFields(schema, arg.typeName);
    out.push(...nested);
  }
  return out;
}

function mutationCreatedType(schema: IngestedGraphqlRich, mutationName: string): string | null {
  const mutation = schema.mutationDetails.find((m) => m.name === mutationName);
  if (!mutation) return null;
  const returnFields = objectFields(schema, mutation.returnTypeName);
  const objectReturn = returnFields.find((f) => !SCALAR_TYPES.has(f.typeName));
  return objectReturn?.typeName ?? mutation.returnTypeName;
}

function deriveGraphqlOracle(schema: IngestedGraphqlRich, mutationName: string): DerivedGraphqlOracle {
  const createdTypeName = mutationCreatedType(schema, mutationName);
  if (!createdTypeName) {
    throw new Error(`Cannot derive GraphQL oracle for ${mutationName}: mutation return type is missing from introspection.`);
  }
  const assertLeaf = identityField(schema, createdTypeName);
  if (!assertLeaf) {
    throw new Error(`Cannot derive GraphQL oracle for ${mutationName}: ${createdTypeName} has no scalar identity field.`);
  }

  const singleRead = schema.queryTypeFields.find((f) => f.typeName === createdTypeName && f.args.includes("id"));
  if (singleRead) {
    return {
      createdTypeName,
      readQueryTemplate: `{ ${singleRead.name}(id: "{gid}") { ${assertLeaf} } }`,
      assertField: `${singleRead.name}.${assertLeaf}`,
      description: `read ${createdTypeName} back by id and assert ${assertLeaf}`,
    };
  }

  const batchRead = schema.queryTypeFields.find((f) => f.typeName === createdTypeName && f.args.includes("ids"));
  if (batchRead) {
    return {
      createdTypeName,
      readQueryTemplate: `{ ${batchRead.name}(ids: ["{gid}"]) { ${assertLeaf} } }`,
      assertField: `${batchRead.name}.0.${assertLeaf}`,
      description: `read ${createdTypeName} back by ids and assert ${assertLeaf}`,
    };
  }

  throw new Error(
    `Cannot derive GraphQL oracle for ${mutationName}: no Query field returns ${createdTypeName} with an id/ids argument.`,
  );
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function inferDependsOn(resource: GraphqlResource, all: GraphqlResource[]): string[] {
  const fieldNames = resource.inputFields.map((f) => normalizeName(f.name));
  const deps: string[] = [];
  for (const candidate of all) {
    if (candidate.mutationName === resource.mutationName) continue;
    const typeKey = normalizeName(candidate.typeName);
    const labelKey = normalizeName(candidate.label);
    const matches = fieldNames.some((field) =>
      field.endsWith("id") && (field.includes(typeKey) || field.includes(labelKey))
    );
    if (matches) deps.push(candidate.mutationName);
  }
  return deps;
}

function findUpdateMutation(schema: IngestedGraphqlRich, resource: GraphqlResource): string | undefined {
  const typeKey = normalizeName(resource.typeName);
  const labelKey = normalizeName(resource.label);
  const identityKey = normalizeName(resource.identityField);
  for (const mutation of schema.mutationDetails) {
    if (schema.createMutations.includes(mutation.name)) continue;
    const nameKey = normalizeName(mutation.name);
    if (!nameKey.includes("update") && !nameKey.includes("edit") && !nameKey.includes("rename")) continue;
    if (!nameKey.includes(typeKey) && !nameKey.includes(labelKey)) continue;
    const inputs = mutationInputFields(schema, mutation.name).map((f) => normalizeName(f.name));
    const hasId = inputs.some((name) => name === "id" || name.endsWith("id"));
    const hasIdentity = inputs.includes(identityKey) || inputs.some((name) => IDENTITY_FIELD_PREFERENCE.includes(name));
    if (hasId && hasIdentity) return mutation.name;
  }
  return undefined;
}

function buildResources(schema: IngestedGraphqlRich, limit: number): GraphqlResource[] {
  const raw: GraphqlResource[] = [];
  for (const mutationName of schema.createMutations) {
    const oracle = deriveGraphqlOracle(schema, mutationName);
    const identity = identityField(schema, oracle.createdTypeName);
    if (!identity) continue;
    const label = resourceLabelFromType(oracle.createdTypeName) || createLabel(mutationName);
    raw.push({
        mutationName,
        label,
        typeName: oracle.createdTypeName,
        identityField: identity,
        inputFields: mutationInputFields(schema, mutationName),
        oracle,
        dependsOn: [],
    });
  }

  for (const resource of raw) {
    resource.dependsOn = inferDependsOn(resource, raw);
    resource.updateMutationName = findUpdateMutation(schema, resource);
  }

  const simple = raw.filter((r) => r.dependsOn.length === 0);
  const composed = raw.filter((r) => r.dependsOn.length > 0);
  return [...simple, ...composed].slice(0, limit);
}

export function generateGraphqlPack(
  schema: IngestedGraphqlRich,
  opts: GenerateGraphqlPackOptions,
): TargetPack {
  if (!isRichGraphqlSchema(schema)) {
    throw new Error(
      "GraphQL pack generation requires rich introspection. Re-run `ax-eval ingest --graphql <endpoint|file>` with this version.",
    );
  }

  const product = opts.product ?? opts.packName;
  const baseUrl = opts.baseUrl ?? (/^https?:\/\//.test(schema.source) ? schema.source : "");
  if (!baseUrl) {
    throw new Error("GraphQL pack generation needs a base URL. Ingest a live endpoint or pass --base-url <graphql-endpoint>.");
  }

  const limit = opts.limit ?? 3;
  const resources = buildResources(schema, Math.max(limit, 10));
  const simpleAll = resources.filter((r) => r.dependsOn.length === 0);
  const simple = simpleAll.slice(0, limit);
  const composed = resources.filter((r) => r.dependsOn.length > 0);
  if (resources.length === 0 || simple.length === 0) {
    throw new Error("GraphQL schema has no create-style mutations with derivable read-back oracles.");
  }

  const tasks: Task[] = [];

  // L1 — single create + read-back. Goal-level, no query/mutation shape injected.
  for (const res of simple) {
    const expected = probeValue(res.label);
    const article = indefiniteArticle(res.label);
    tasks.push({
      id: `gen-gql-l1-${slugPart(res.label)}`,
      title: `L1: create ${article} ${res.label}`,
      difficulty: "L1",
      prompt:
        `Create one ${res.label} named "${expected}" using the GraphQL API you discovered. ` +
        `Report the created id.`,
      allowed_surfaces: ["api", "docs"],
      depends_on: [],
      trace: [],
      oracles: [graphqlOracle(res.oracle, expected)],
    });
  }

  // L2 — composed chain: create a parent resource, then create a child whose
  // input carries that parent id.
  const l2Limit = opts.l2Limit ?? 3;
  const seenChild = new Set<string>();
  for (const child of composed) {
    if (tasks.filter((t) => t.difficulty === "L2").length >= l2Limit) break;
    if (seenChild.has(child.mutationName)) continue;
    const parentName = child.dependsOn[0];
    const parent = simpleAll.find((r) => r.mutationName === parentName);
    if (!parent) continue;
    seenChild.add(child.mutationName);
    const childVal = probeValue(child.label);
    tasks.push({
      id: `gen-gql-l2-${slugPart(parent.label)}-${slugPart(child.label)}`,
      title: `L2: create ${indefiniteArticle(child.label)} ${child.label} under ${indefiniteArticle(parent.label)} ${parent.label}`,
      difficulty: "L2",
      prompt:
        `First create ${indefiniteArticle(parent.label)} ${parent.label}. Then, using its id, ` +
        `create ${indefiniteArticle(child.label)} ${child.label} named "${childVal}". Report both ids.`,
      allowed_surfaces: ["api", "docs"],
      depends_on: [parent.label],
      trace: [],
      oracles: [graphqlOracle(child.oracle, childVal)],
    });
  }

  // L3 — ambiguous natural-language goal. Prefer task/issue-like resources.
  const l3 = simple.find((r) => /task|issue|todo/i.test(r.label)) ?? simple[0];
  if (l3) {
    const val = probeValue(`${l3.label}-goal`);
    tasks.push({
      id: `gen-gql-l3-${slugPart(l3.label)}`,
      title: "L3: ambiguous goal-level (comprehension)",
      difficulty: "L3",
      prompt:
        `A teammate messages you: "Please add \\"${val}\\" to my to-do list in this ` +
        `workspace so I don't forget to do it." Work out what to create to satisfy ` +
        `this and create it with the GraphQL API you discovered. Report the id of the item you created.`,
      allowed_surfaces: ["api", "docs"],
      depends_on: [],
      trace: [],
      oracles: [graphqlOracle(l3.oracle, val)],
    });
  }

  // L4 — generic lifecycle: create then update/rename the same resource, derived
  // from update-like mutations whose input accepts id + identity field.
  const l4Limit = opts.l4Limit ?? 3;
  const lifecycle = simple.filter((r) => r.updateMutationName);
  for (const res of lifecycle.slice(0, l4Limit)) {
    const before = probeValue(`${res.label}-pre`);
    const after = probeValue(`${res.label}-renamed`);
    tasks.push({
      id: `gen-gql-l4-${slugPart(res.label)}-lifecycle`,
      title: `L4: full lifecycle — create then rename ${indefiniteArticle(res.label)} ${res.label}`,
      difficulty: "L4",
      prompt:
        `Create one ${res.label} named "${before}" using the GraphQL API you discovered, then ` +
        `update that same ${res.label} so its ${res.identityField} is "${after}". Report its id.`,
      allowed_surfaces: ["api", "docs"],
      depends_on: [],
      trace: [],
      oracles: [graphqlOracle(res.oracle, after)],
    });
  }

  const officialDomains = [
    hostOf(opts.siteUrl ?? ""),
    ...(opts.docsUrls ?? []).map(hostOf),
  ].filter((h, i, a) => h && a.indexOf(h) === i);

  return {
    name: opts.packName,
    version: opts.version ?? "0",
    standard_set_version: opts.standardSetVersion ?? `gen-${new Date().toISOString().slice(0, 10)}`,
    run_id: opts.runId ?? newRunId(),
    generated_by: GRAPHQL_GENERATED_BY,
    api_style: "graphql",
    auth_method: opts.authMethod ?? "api-key",
    auth: deriveAuth(product, opts),
    sandbox_scope: opts.sandboxScope ?? [],
    base_url: baseUrl,
    headers: opts.headers ?? {},
    site_url: opts.siteUrl ?? "",
    openapi_url: "",
    docs_urls: opts.docsUrls ?? [],
    static: opts.siteUrl ? { site_url: opts.siteUrl, docs_urls: opts.docsUrls ?? [], checks: [] } : undefined,
    discovery: {
      product,
      goal:
        `You are about to operate ${product} programmatically. First work out, ` +
        `from scratch, how ${product}'s public GraphQL API works — its single endpoint, ` +
        `how to authenticate, the introspectable schema, and how to create resources — ` +
        `then you will perform several tasks. You are NOT given any endpoint, base URL, ` +
        `or documentation link; find them yourself.`,
      official_domains: officialDomains,
      canonical_endpoint: canonicalEndpoint(simple[0]!.mutationName),
      deprecated_markers: [],
      auth_scheme: opts.authMethod ?? "API key in the Authorization header",
    },
    tasks,
  };
}
