/**
 * GraphQL pack generation. Unlike the OpenAPI path, GraphQL schemas do not
 * expose a target-agnostic CRUD graph, so this generator limits itself to the
 * productizable floor: create-style mutations plus deterministic read-back
 * oracles derived from common GraphQL introspection conventions.
 */
import type { IngestedGraphqlRich } from "../ingest/graphql.js";
import type { Auth, OracleSpec, ScopeParam, Task, TargetPack } from "../schemas.js";
import { newRunId, probeValue } from "./pack.js";
import {
  declaredTaskAllowedSurfaces,
  taskAllowedSurfacesForResources,
  type SurfaceTaskPolicies,
} from "./surface-policy.js";

export const GRAPHQL_GENERATED_BY = "deterministic@graphql-pack";

export interface GenerateGraphqlPackOptions {
  limit?: number;
  l2Limit?: number;
  l3Limit?: number;
  l4Limit?: number;
  targetTaskCount?: number;
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
  surfaces?: TargetPack["surfaces"];
  surfaceTaskPolicies?: SurfaceTaskPolicies;
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

const IDENTITY_FIELD_PREFERENCE = ["name", "title", "label", "text", "body", "content", "summary", "description"];
const SCALAR_TYPES = new Set(["String", "ID", "UUID", "Int", "Float", "Boolean", "Date", "DateTime"]);
const PREFERRED_RESOURCE_RE = /\b(issue|task|todo|to do|comment|project|cycle|initiative|document|note)\b/i;
const DEPRIORITIZED_RESOURCE_RE = /\b(customer|organization|auth|agent|prompt|skill|subscription|notification|sales|attachment)\b/i;
const RISKY_RESOURCE_RE = /\b(customer|organization|auth|agent|prompt|skill|subscription|notification|sales|attachment|integration|oauth|application|release|pipeline|status|setting|config|preference|membership|permission|role|emoji|schedule)\b/i;
const AMBIGUOUS_GOAL_LABEL_RE = /^(issue|task|todo|project|document|note)$/i;

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
  return {
    type,
    env,
    env_aliases: [],
    verify_env_aliases: [],
    ...(header ? { header } : {}),
  };
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

function valuePrompt(field: string, value: string): string {
  if (field === "name" || field === "title" || field === "label" || field === "summary") {
    return `named "${value}"`;
  }
  return `with ${field} "${value}"`;
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
  return fields.find((f) => SCALAR_TYPES.has(f.typeName) && f.name !== "id")?.name ?? null;
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

function isAmbientDependency(name: string): boolean {
  return /team|workspace|organization|viewer/i.test(name);
}

function isStrongDependencyChain(resource: GraphqlResource): boolean {
  return resource.dependsOn.length === 1 && !resource.dependsOn.every(isAmbientDependency);
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

function resourceKey(resource: GraphqlResource): string {
  return `${resource.label} ${resource.typeName} ${resource.mutationName}`;
}

function isRiskyResource(resource: GraphqlResource): boolean {
  return RISKY_RESOURCE_RE.test(resourceKey(resource));
}

function isL3Eligible(resource: GraphqlResource): boolean {
  return AMBIGUOUS_GOAL_LABEL_RE.test(resource.label) && !isRiskyResource(resource);
}

function isLifecycleEligible(resource: GraphqlResource): boolean {
  return Boolean(resource.updateMutationName)
    && resource.identityField !== "id"
    && !/^cycle$/i.test(resource.label)
    && !isRiskyResource(resource);
}

function preferredResourceBoost(resource: GraphqlResource): number {
  if (/^(issue|task|todo)$/i.test(resource.label)) return 30;
  if (/^(project|document|note|comment)$/i.test(resource.label)) return 20;
  if (/^(cycle|initiative|project label)$/i.test(resource.label)) return 10;
  return 0;
}

function resourcePriority(resource: GraphqlResource): number {
  const key = resourceKey(resource);
  let score = 0;
  if (PREFERRED_RESOURCE_RE.test(key)) score += 50;
  score += preferredResourceBoost(resource);
  if (DEPRIORITIZED_RESOURCE_RE.test(key)) score -= 25;
  if (isRiskyResource(resource)) score -= 100;
  if (/batch|import|sync/i.test(resource.mutationName)) score -= 10;
  if (resource.updateMutationName) score += 5;
  if (resource.dependsOn.length === 0) score += 2;
  return score;
}

const GRAPHQL_L3_PROMPTS = [
  (val: string) =>
    `A teammate messages you: "Please add \\"${val}\\" to my to-do list in this workspace so I don't forget to do it." Work out what to create to satisfy this and create it with the GraphQL API you discovered. Report the id of the item you created.`,
  (val: string) =>
    `A coworker asks: "Can you set up \\"${val}\\" in this workspace for me?" Infer what object best satisfies that request, create it with the GraphQL API you discovered, and report its id.`,
  (val: string) =>
    `Someone says: "I need \\"${val}\\" tracked in this workspace today." Decide what to create, create it with the GraphQL API you discovered, and report the created id.`,
] as const;

function graphqlGoalRank(resource: GraphqlResource): number {
  const key = resourceKey(resource);
  if (/task|issue|todo/i.test(key)) return 100;
  if (PREFERRED_RESOURCE_RE.test(key)) return 60;
  return 0;
}

function graphqlL3Task(resource: GraphqlResource, index: number, allowedSurfaces: string[]): Task {
  const val = probeValue(`${resource.label}-goal-${index + 1}`);
  return {
    id: `gen-gql-l3-${slugPart(resource.label)}-${index + 1}`,
    title: `L3: ambiguous goal-level — ${resource.label}`,
    difficulty: "L3",
    prompt: GRAPHQL_L3_PROMPTS[index % GRAPHQL_L3_PROMPTS.length]!(val),
    allowed_surfaces: allowedSurfaces,
    na: false,
    depends_on: [],
    trace: [],
    oracles: [graphqlOracle(resource.oracle, val)],
  };
}

function appendUniqueTasks(target: Task[], pool: Task[], maxCount: number): void {
  const seen = new Set(target.map((t) => t.id));
  for (const task of pool) {
    if (target.length >= maxCount) break;
    if (seen.has(task.id)) continue;
    target.push(task);
    seen.add(task.id);
  }
}

function buildResources(schema: IngestedGraphqlRich, limit: number): GraphqlResource[] {
  const raw: GraphqlResource[] = [];
  for (const mutationName of schema.createMutations) {
    let oracle: DerivedGraphqlOracle;
    try {
      oracle = deriveGraphqlOracle(schema, mutationName);
    } catch {
      continue;
    }
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

  const safe = raw.filter((resource) => !isRiskyResource(resource));
  const eligible = safe.length > 0 ? safe : raw;

  eligible.sort((a, b) =>
    resourcePriority(b) - resourcePriority(a)
    || a.dependsOn.length - b.dependsOn.length
    || a.label.localeCompare(b.label)
  );

  const deduped: GraphqlResource[] = [];
  const seenLabels = new Set<string>();
  for (const resource of eligible) {
    if (seenLabels.has(resource.label)) continue;
    seenLabels.add(resource.label);
    deduped.push(resource);
  }

  const simple = deduped.filter((r) => !isStrongDependencyChain(r));
  const composed = deduped.filter(isStrongDependencyChain);
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

  const baseUrl = opts.baseUrl ?? (/^https?:\/\//.test(schema.source) ? schema.source : "");
  if (!baseUrl) {
    throw new Error("GraphQL pack generation needs a base URL. Ingest a live endpoint or pass --base-url <graphql-endpoint>.");
  }

  const limit = opts.limit ?? 3;
  const l2Limit = opts.l2Limit ?? 3;
  const l3Limit = opts.l3Limit ?? 1;
  const l4Limit = opts.l4Limit ?? 3;
  const targetTaskCount = opts.targetTaskCount;
  const product = opts.product ?? opts.packName;
  const allowedSurfaces = declaredTaskAllowedSurfaces(opts.surfaces);
  const resources = buildResources(schema, Math.max(limit, l2Limit, l3Limit, l4Limit, targetTaskCount ?? 10, 10));
  const simpleAll = resources.filter((r) => !isStrongDependencyChain(r));
  const simple = simpleAll.slice(0, limit);
  const composed = resources.filter(isStrongDependencyChain);
  if (resources.length === 0 || simple.length === 0) {
    throw new Error("GraphQL schema has no create-style mutations with derivable read-back oracles.");
  }

  // L1 — single create + read-back. Goal-level, no query/mutation shape injected.
  const l1Pool: Task[] = [];
  for (const res of simpleAll) {
    const expected = probeValue(res.label);
    const article = indefiniteArticle(res.label);
    l1Pool.push({
      id: `gen-gql-l1-${slugPart(res.label)}`,
      title: `L1: create ${article} ${res.label}`,
      difficulty: "L1",
      prompt:
        `Create one ${res.label} ${valuePrompt(res.identityField, expected)} using the GraphQL API you discovered. ` +
        `Report the created id.`,
      allowed_surfaces: taskAllowedSurfacesForResources(
        allowedSurfaces,
        opts.surfaceTaskPolicies,
        "simple",
        [res.label],
      ),
      na: false,
      depends_on: [],
      trace: [],
      oracles: [graphqlOracle(res.oracle, expected)],
    });
  }

  // L2 — composed chain: create a parent resource, then create a child whose
  // input carries that parent id.
  const seenChild = new Set<string>();
  const l2Pool: Task[] = [];
  for (const child of composed) {
    if (seenChild.has(child.mutationName)) continue;
    const parentName = child.dependsOn[0];
    const parent = simpleAll.find((r) => r.mutationName === parentName);
    if (!parent) continue;
    seenChild.add(child.mutationName);
    const childVal = probeValue(child.label);
    l2Pool.push({
      id: `gen-gql-l2-${slugPart(parent.label)}-${slugPart(child.label)}`,
      title: `L2: create ${indefiniteArticle(child.label)} ${child.label} under ${indefiniteArticle(parent.label)} ${parent.label}`,
      difficulty: "L2",
      prompt:
        `First create ${indefiniteArticle(parent.label)} ${parent.label}. Then, using its id, ` +
        `create ${indefiniteArticle(child.label)} ${child.label} ${valuePrompt(child.identityField, childVal)}. Report both ids.`,
      allowed_surfaces: taskAllowedSurfacesForResources(
        allowedSurfaces,
        opts.surfaceTaskPolicies,
        "nested",
        [parent.label, child.label],
      ),
      na: false,
      depends_on: [parent.label],
      trace: [],
      oracles: [graphqlOracle(child.oracle, childVal)],
    });
  }

  // L3 — ambiguous natural-language goal. Prefer task/issue-like resources.
  const l3Candidates = simpleAll
    .filter(isL3Eligible)
    .sort((a, b) => graphqlGoalRank(b) - graphqlGoalRank(a) || a.label.localeCompare(b.label));
  const l3Pool = l3Candidates.map((resource, index) => graphqlL3Task(
    resource,
    index,
    taskAllowedSurfacesForResources(
      allowedSurfaces,
      opts.surfaceTaskPolicies,
      "goal",
      [resource.label],
    ),
  ));

  // L4 — generic lifecycle: create then update/rename the same resource, derived
  // from update-like mutations whose input accepts id + identity field.
  const lifecycle = simpleAll.filter(isLifecycleEligible);
  const l4Pool: Task[] = [];
  for (const res of lifecycle) {
    const before = probeValue(`${res.label}-pre`);
    const after = probeValue(`${res.label}-renamed`);
    const allowedLifecycleSurfaces = taskAllowedSurfacesForResources(
      allowedSurfaces,
      opts.surfaceTaskPolicies,
      "lifecycle",
      [res.label],
    );
    l4Pool.push({
      id: `gen-gql-l4-${slugPart(res.label)}-lifecycle`,
      title: `L4: full lifecycle — create then rename ${indefiniteArticle(res.label)} ${res.label}`,
      difficulty: "L4",
      prompt:
        `Create one ${res.label} ${valuePrompt(res.identityField, before)} using the GraphQL API you discovered, then ` +
        `update that same ${res.label} so its ${res.identityField} is "${after}". Report its id.`,
      allowed_surfaces: allowedLifecycleSurfaces,
      na: false,
      depends_on: [],
      trace: [],
      oracles: [graphqlOracle(res.oracle, after)],
    });
  }

  const selectedL1 = l1Pool.slice(0, limit);
  const selectedL2 = l2Pool.slice(0, l2Limit);
  const selectedL3 = l3Pool.slice(0, l3Limit);
  const selectedL4 = l4Pool.slice(0, l4Limit);
  if (targetTaskCount && targetTaskCount > 0) {
    let total = selectedL1.length + selectedL2.length + selectedL3.length + selectedL4.length;
    if (total < targetTaskCount) appendUniqueTasks(selectedL4, l4Pool.slice(l4Limit), targetTaskCount - total + selectedL4.length);
    total = selectedL1.length + selectedL2.length + selectedL3.length + selectedL4.length;
    if (total < targetTaskCount) appendUniqueTasks(selectedL3, l3Pool.slice(l3Limit), targetTaskCount - total + selectedL3.length);
    total = selectedL1.length + selectedL2.length + selectedL3.length + selectedL4.length;
    if (total < targetTaskCount) appendUniqueTasks(selectedL2, l2Pool.slice(l2Limit), targetTaskCount - total + selectedL2.length);
    total = selectedL1.length + selectedL2.length + selectedL3.length + selectedL4.length;
    if (total < targetTaskCount) appendUniqueTasks(selectedL1, l1Pool.slice(limit), targetTaskCount - total + selectedL1.length);
  }

  const tasks: Task[] = [...selectedL1, ...selectedL2, ...selectedL3, ...selectedL4];

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
    surfaces: opts.surfaces,
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
