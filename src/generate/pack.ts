/**
 * Pack drafting helpers: turn an IngestedSpec plus optional authoring hints into
 * a standard_set draft (tasks + programmatic round-trip oracles), with a
 * difficulty ladder. The deterministic rule-derived path is still available for
 * CI/offline fixtures; product-quality CLI generation records LLM-assisted
 * authoring provenance and becomes reproducible only after review approval.
 *
 * Difficulty comes from what the executor is told, not from how we check. Task
 * prompts are GOAL-LEVEL and never name the endpoint, base URL, or request
 * shape — those are discovered by the executor in its Phase 0 (see
 * harness/executor). So the ladder is purely about execution complexity, on top
 * of a shared discovery foundation:
 *   L1 single create (resource type named) — breadth/smoke, kept small
 *   L2 composed chain (create parent → create child under it)
 *   L3 ambiguous, natural-language goal (comprehension; resource type NOT named)
 *   L4 full lifecycle — the depth tier:
 *      · generic: create → rename → read-back the NEW value (spec-derived from
 *        resources that expose an update endpoint; no authoring)
 *      · curated: post-create state mutations not derivable from the spec
 *        (complete / reschedule / archive)
 */
import { stringify as yamlStringify } from "yaml";
import type { IngestedSpec, CrudResource } from "../ingest/openapi.js";
import type { Auth, GeneratorProvenance, OracleSpec, ScopeParam, Task, TargetPack } from "../schemas.js";
import {
  declaredTaskAllowedSurfaces,
  taskAllowedSurfacesForOperation,
  taskAllowedSurfacesForResources,
  type SurfaceTaskPolicies,
} from "./surface-policy.js";

export const GENERATED_BY = "deterministic@no-model";

/** Prefix every generated probe resource name carries, so a teardown (reset)
 *  can recognize AX-created resources without a baked id. */
export const PROBE_PREFIX = "AX probe";

/**
 * Per-generation id — a frozen *version tag* for the standard_set (pack
 * metadata), NOT part of resource names. Short, sortable: <date>-<6 base36>.
 */
export function newRunId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${date}-${rand}`;
}

/**
 * Probe names carry a `{ns}` placeholder, NOT a baked id. The namespace is
 * resolved per *execution* (per harness × attempt), so two harnesses running
 * the same frozen pack never collide on resource names — while the oracle's
 * `expected` stays an exact-match template (verify substitutes the same ns).
 */
export const NS_PLACEHOLDER = "{ns}";

export function probeValue(resource: string): string {
  return `${PROBE_PREFIX} ${resource} ${NS_PLACEHOLDER}`;
}

/** Build the round-trip oracle for a created resource. */
function roundtripOracle(
  res: CrudResource,
  expected: unknown,
  responseEnvelope: string | null,
  assertField?: string,
): OracleSpec {
  return {
    type: "roundtrip",
    description: `read ${res.name} back and assert ${assertField ?? res.identityField}`,
    readPathTemplate: res.readPath.replace(`{${res.readParam}}`, "{gid}"),
    responseEnvelope: responseEnvelope ?? undefined,
    assertField: assertField ?? res.identityField,
    expected,
  };
}

/** A resource is "simple" (L1/L3-eligible) when its create path has no params. */
function isSimple(res: CrudResource): boolean {
  return !/\{[^}]+\}/.test(res.createPath);
}

/**
 * A curated L4 task. L4 is intentionally NOT pure-deterministic from the spec:
 * it exercises post-create *state mutations* (complete/reschedule/etc.) that an
 * L1 create+read-back never touches, so it must be authored (per the design:
 * "L4 default strongest config"). The oracle still reads back one field and
 * asserts a fixed expected value, so verification stays programmatic.
 *
 * The only placeholder in `prompt` is {val} (the unique probe name). Like every
 * other tier, L4 prompts are goal-level and never name the endpoint.
 */
export interface L4Template {
  /** Final id = gen-l4-<idSuffix>. */
  idSuffix: string;
  title: string;
  /** Must match a simple CRUD resource in the spec, else the template is skipped. */
  resource: string;
  prompt: string;
  allowedSurfaces?: string[];
  /** Field to read back after the multi-step flow + its expected post-state value. */
  assertField: string;
  expected: unknown;
}

export interface OperationTaskTemplate {
  id: string;
  title: string;
  difficulty: Task["difficulty"];
  prompt: string;
  /** Operation calls expected in the executor trace. */
  trace?: Task["trace"];
  /** Live read-back URL the executor must report as gid. */
  expectedUrl: string;
  /** Other URL forms that should count as the same correct source. */
  expectedAny?: string[];
  matchMode?: OracleSpec["matchMode"];
  /** POST endpoint used by verification to read the reported URL back. */
  readPath?: string;
}

export interface GenerateOptions {
  /** Max number of L1 single-create tasks (default 3). L1 is breadth/smoke; the
   *  depth lives in the L4 lifecycle tier, so this stays small. */
  limit?: number;
  /** Max number of L2 composed chains to emit (default 3). */
  l2Limit?: number;
  /** Max number of L3 ambiguous goal-level tasks to emit (default 1). */
  l3Limit?: number;
  /** Max number of generic L4 lifecycle tasks (create→rename→read-back) derived
   *  from spec update endpoints (default 3). 0 disables generic lifecycle. */
  l4Limit?: number;
  /** Soft target for the total task count. If earlier tiers come up short,
   *  generation backfills from harder tiers before widening L1 breadth. */
  targetTaskCount?: number;
  packName: string;
  version?: string;
  standardSetVersion?: string;
  baseUrl?: string;
  authMethod?: string;
  siteUrl?: string;
  /** OpenAPI spec URL to record on the pack for the content-quality (v3 smell)
   *  audit. Defaults to the ingested spec's source when it's an http(s) URL. */
  openapiUrl?: string;
  docsUrls?: string[];
  /** Resource names to prioritize (well-known, sandbox-safe) before the rest. */
  prefer?: string[];
  /** Override the frozen generation version tag (tests / reproducibility). */
  runId?: string;
  /** Curated L4 scenarios (post-create state mutations). Appended when their
   *  resource exists in the spec. */
  l4?: L4Template[];
  /** Product name to enable the cold-start discovery probe (behavioral AEO). */
  product?: string;
  /** Human label of the auth scheme, surfaced in the discovery auth check. */
  authScheme?: string;
  /** Override the read-back identity field for resources whose OpenAPI ingest
   *  mis-detects it (e.g. Asana project_briefs/project_statuses use `title`,
   *  not `name`). Maps resource name → the field the round-trip oracle asserts. */
  identityOverrides?: Record<string, string>;
  /** Auth overrides for specs that don't declare `securitySchemes` (the env-var
   *  names + scheme can't be inferred from such a spec). When unset, derived from
   *  the ingested security + product name. */
  authType?: Auth["type"];
  authEnv?: string;
  authVerifyEnv?: string;
  authHeader?: string;
  /** Replace the derived sandbox-scope scaffold with explicit params. */
  sandboxScope?: ScopeParam[];
  /** Constant headers to use instead of the ingested defaults. */
  headers?: Record<string, string>;
  /** Non-API surfaces exposed by this product (SDK/MCP/CLI). */
  surfaces?: TargetPack["surfaces"];
  /** Optional per-surface task coverage shaping. */
  surfaceTaskPolicies?: SurfaceTaskPolicies;
  /** Additional fully-authored tasks to append after rule-derived generation. */
  curatedTasks?: Task[];
  /** Resources to omit from generic deterministic task generation. */
  excludeResources?: string[];
  /** POST-only / stateless operation tasks for APIs that don't expose CRUD
   *  resources for their core value path (e.g. search/content APIs). */
  operationTasks?: OperationTaskTemplate[];
  /** Override the discovery probe when the canonical product action is not a
   *  CRUD create endpoint. */
  discoveryGoal?: string;
  discoveryCanonicalEndpoint?: string;
  deprecatedMarkers?: string[];
  /** Override pack provenance for LLM-assisted authoring flows. */
  generatedBy?: string;
  generator?: GeneratorProvenance;
}

/** UPPER_SNAKE slug of a product/pack name, for env-var derivation. */
function productSlug(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Best-effort singular of a collection name, for a scope label. */
function singularize(name: string): string {
  return name.replace(/ies$/i, "y").replace(/s$/i, "");
}

/**
 * Derive the declarative `auth` block. Type/header come from the ingested spec
 * (or an `authMethod` hint when the spec declares no scheme); the env-var name
 * is product-derived (`<PRODUCT>_API_KEY` / `<PRODUCT>_TOKEN`). Explicit opts win
 * — necessary for specs (like Asana) whose auth isn't in the OpenAPI document.
 */
function deriveAuth(spec: IngestedSpec, opts: GenerateOptions, slug: string): Auth {
  const specAuth = spec.auth ?? { type: "none" as const, header: null };
  const type: Auth["type"] =
    opts.authType ??
    (specAuth.type !== "none"
      ? specAuth.type
      : opts.authMethod && opts.authMethod !== "none"
        ? opts.authMethod === "api-key"
          ? "api-key"
          : "bearer"
        : "none");
  const env = opts.authEnv ?? (type === "none" ? "" : `${slug}_${type === "api-key" ? "API_KEY" : "TOKEN"}`);
  // Emit a header only when it's load-bearing: api-key (name is non-obvious) or
  // a non-Authorization override. Bearer/oauth default to Authorization in the
  // client, so leave it implicit.
  let header: string | undefined;
  if (opts.authHeader) header = opts.authHeader;
  else if (type === "api-key" && specAuth.header) header = specAuth.header;
  else if (specAuth.header && specAuth.header !== "Authorization") header = specAuth.header;
  return {
    type,
    env,
    env_aliases: [],
    verify_env_aliases: [],
    ...(opts.authVerifyEnv ? { verify_env: opts.authVerifyEnv } : {}),
    ...(header ? { header } : {}),
  };
}

/**
 * Derive a structurally-complete sandbox-scope scaffold: one entry for the
 * top-level container the tasks create under (the parent of the first composed
 * chain, else the top simple resource). The id itself is human-provided — this
 * just names the var and tells the reviewer what to paste. Empty when no
 * container can be inferred.
 */
function deriveScopeScaffold(
  product: string,
  slug: string,
  simple: CrudResource[],
  composed: CrudResource[],
): ScopeParam[] {
  const container = composed[0]?.dependsOn[0] ?? simple[0]?.name;
  if (!container) return [];
  const scope = singularize(container);
  return [
    {
      name: `${scope}_id`,
      env: `${slug}_SANDBOX_${productSlug(scope)}_ID`,
      required: true,
      instructions:
        `Create a throwaway ${product} ${scope} and paste its id (or URL) here, so the ` +
        `generated tasks create resources inside an isolated sandbox you can safely reset.`,
    },
  ];
}

/** Hostname of a URL, or "" if unparseable. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Order resources by a preference list, then alphabetically. */
function orderByPreference<T extends { name: string }>(items: T[], prefer: string[]): T[] {
  const rank = (n: string) => {
    const i = prefer.indexOf(n);
    return i === -1 ? prefer.length : i;
  };
  return [...items].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

function isActionLikeResource(res: CrudResource): boolean {
  return res.name.toLowerCase() === "export" || /\/exports?(?:\/|$)/i.test(res.createPath);
}

const REST_L3_PROMPTS = [
  (val: string) =>
    `A teammate messages you: "Please add \\"${val}\\" to my to-do list in this workspace so I don't forget to do it." Work out what to create to satisfy this and create it. Report the id of the item you created.`,
  (val: string) =>
    `A coworker says: "Can you set up \\"${val}\\" in this workspace for me?" Decide what kind of record best satisfies that request, create it, and report its id.`,
  (val: string) =>
    `Someone asks: "I need \\"${val}\\" tracked in this workspace today." Infer what object to create, create it, and report the created id.`,
] as const;

function restGoalRank(res: CrudResource): number {
  if (res.name === "tasks") return 100;
  if (/task|todo|issue/i.test(res.name)) return 80;
  return 0;
}

function restL3Task(
  res: CrudResource,
  spec: IngestedSpec,
  env: string | null,
  assertField: string,
  index: number,
  allowedSurfaces: string[],
): Task {
  const val = probeValue(`${res.name}-goal-${index + 1}`);
  return {
    id: `gen-l3-${res.name}-${index + 1}`,
    title: `L3: ambiguous goal-level — ${singularize(res.name)}`,
    difficulty: "L3",
    prompt: REST_L3_PROMPTS[index % REST_L3_PROMPTS.length]!(val),
    allowed_surfaces: allowedSurfaces,
    na: false,
    create_path: res.createPath,
    create_envelope: spec.requestEnvelope ?? undefined,
    depends_on: [],
    trace: [],
    oracles: [roundtripOracle(res, val, env, assertField)],
  };
}

function appendUntil(target: Task[], pool: Task[], maxCount: number): void {
  const seen = new Set(target.map((t) => t.id));
  for (const task of pool) {
    if (target.length >= maxCount) break;
    if (seen.has(task.id)) continue;
    target.push(task);
    seen.add(task.id);
  }
}

export function generatePack(spec: IngestedSpec, opts: GenerateOptions): TargetPack {
  const limit = opts.limit ?? 3;
  const l2Limit = opts.l2Limit ?? 3;
  const l3Limit = opts.l3Limit ?? 1;
  const l4Limit = opts.l4Limit ?? 3;
  const targetTaskCount = opts.targetTaskCount;
  const prefer = opts.prefer ?? [];
  const runId = opts.runId ?? newRunId();
  const env = spec.responseEnvelope;
  const overrides = opts.identityOverrides ?? {};
  const allowedSurfaces = declaredTaskAllowedSurfaces(opts.surfaces);
  const excludedResources = new Set(
    (opts.excludeResources ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean),
  );
  /** Read-back identity field for a resource (override → ingest default). */
  const idField = (res: CrudResource): string => overrides[res.name] ?? res.identityField;
  const generatableResources = spec.resources.filter(
    (res) => !isActionLikeResource(res) && !excludedResources.has(res.name.toLowerCase()),
  );
  const simpleAll = generatableResources.filter(isSimple);
  const simpleNames = new Set(simpleAll.map((r) => r.name));
  const simpleOrdered = orderByPreference(simpleAll, prefer);
  const simple = simpleOrdered.slice(0, limit);
  // Composed chains: only genuinely-nested resources (no simple create of the
  // same name), so we don't pick a team-scoped duplicate of a top-level create.
  const composed = orderByPreference(
    generatableResources.filter(
      (r) => !isSimple(r) && r.dependsOn.length > 0 && !simpleNames.has(r.name),
    ),
    prefer,
  );

  const l1Pool: Task[] = [];
  for (const res of simpleOrdered) {
    const val = probeValue(res.name);
    l1Pool.push({
      id: `gen-l1-${res.name}`,
      title: `L1: create a ${res.name}`,
      difficulty: "L1",
      prompt:
        `Create one ${res.name} named "${val}" in the sandbox workspace, using the ` +
        `API you discovered. Report the created id.`,
      allowed_surfaces: taskAllowedSurfacesForResources(
        allowedSurfaces,
        opts.surfaceTaskPolicies,
        "simple",
        [res.name],
      ),
      na: false,
      create_path: res.createPath,
      create_envelope: spec.requestEnvelope ?? undefined,
      depends_on: [],
      trace: [],
      oracles: [roundtripOracle(res, val, env, idField(res))],
    });
  }

  // L2 — composed chains: create parent, then create child under it. Multiple
  // chains (capped) whose parent is a simple, preference-ranked resource. Still
  // goal-level: no endpoints named.
  const seenChild = new Set<string>();
  const l2Pool: Task[] = [];
  for (const chain of composed) {
    const parentName = chain.dependsOn[0]!;
    const parent = spec.resources.find((r) => r.name === parentName && isSimple(r));
    if (!parent || seenChild.has(chain.name)) continue;
    seenChild.add(chain.name);
    const childVal = probeValue(chain.name);
    l2Pool.push({
      id: `gen-l2-${parent.name}-${chain.name}`,
      title: `L2: create a ${chain.name} under a ${parent.name}`,
      difficulty: "L2",
      prompt:
        `First create a ${parent.name}. Then, using its id, create a ${chain.name} ` +
        `under it named "${childVal}". Report both ids.`,
      allowed_surfaces: taskAllowedSurfacesForResources(
        allowedSurfaces,
        opts.surfaceTaskPolicies,
        "nested",
        [parent.name, chain.name],
      ),
      na: false,
      create_path: chain.createPath,
      create_envelope: spec.requestEnvelope ?? undefined,
      depends_on: [parent.name],
      trace: [],
      // Assert the child reads back with the right identity (linkage is implied
      // by having created it under the parent id).
      oracles: [roundtripOracle(chain, childVal, env, idField(chain))],
    });
  }

  // L3 — ambiguous, natural-language goal (comprehension). The resource type is
  // NOT named; the agent must infer that a to-do item ("task") satisfies it. The
  // oracle still reads back a concrete resource, so scoring stays programmatic.
  const l3Candidates = [...simpleOrdered].sort((a, b) => restGoalRank(b) - restGoalRank(a) || a.name.localeCompare(b.name));
  const l3Pool = l3Candidates.map((res, index) => restL3Task(
    res,
    spec,
    env,
    idField(res),
    index,
    taskAllowedSurfacesForResources(
      allowedSurfaces,
      opts.surfaceTaskPolicies,
      "goal",
      [res.name],
    ),
  ));

  // L4 (generic) — full create→update→read-back lifecycle, derived from the spec
  // (no authoring). For each top simple resource whose item path exposes an
  // update (PATCH/PUT), create it under one name then RENAME it to a second; the
  // round-trip oracle reads the resource back and asserts the identity field now
  // holds the NEW value — so passing requires the update to have really landed,
  // not just the create. This is the depth tier (vs L1 breadth). Resources a
  // curated L4 already mutates are skipped to avoid exercising the same flow twice.
  const curatedResources = new Set((opts.l4 ?? []).map((t) => t.resource));
  const lifecycleCandidates = simpleOrdered.filter((r) => r.canUpdate && !curatedResources.has(r.name));
  const l4GenericPool: Task[] = [];
  for (const res of lifecycleCandidates) {
    const before = probeValue(`${res.name}-pre`);
    const after = probeValue(`${res.name}-renamed`);
    l4GenericPool.push({
      id: `gen-l4-${res.name}-lifecycle`,
      title: `L4: full lifecycle — create then rename a ${res.name}`,
      difficulty: "L4",
      prompt:
        `Create one ${res.name} named "${before}" in the sandbox workspace, then ` +
        `update that same ${res.name} so its ${idField(res)} is "${after}". Report its id.`,
      allowed_surfaces: taskAllowedSurfacesForResources(
        allowedSurfaces,
        opts.surfaceTaskPolicies,
        "lifecycle",
        [res.name],
      ),
      na: false,
      create_path: res.createPath,
      create_envelope: spec.requestEnvelope ?? undefined,
      depends_on: [],
      trace: [],
      // Assert the POST-UPDATE value reads back — the create name must be gone.
      oracles: [roundtripOracle(res, after, env, idField(res))],
    });
  }

  // L4 (curated) — multi-step state mutations (create then change state, assert
  // the changed field reads back) that aren't derivable from the spec, e.g.
  // complete / reschedule / archive. Skipped silently if the resource is absent.
  const l4CuratedPool: Task[] = [];
  let usedL4 = false;
  for (const tmpl of opts.l4 ?? []) {
    const res = simpleAll.find((r) => r.name === tmpl.resource);
    if (!res) continue;
    usedL4 = true;
    const val = probeValue(`${tmpl.resource}-${tmpl.idSuffix}`);
    l4CuratedPool.push({
      id: `gen-l4-${tmpl.idSuffix}`,
      title: tmpl.title,
      difficulty: "L4",
      prompt: tmpl.prompt.replace(/\{val\}/g, val),
      allowed_surfaces: tmpl.allowedSurfaces ?? taskAllowedSurfacesForResources(
        allowedSurfaces,
        opts.surfaceTaskPolicies,
        "lifecycle",
        [tmpl.resource],
      ),
      na: false,
      create_path: res.createPath,
      create_envelope: spec.requestEnvelope ?? undefined,
      depends_on: [],
      trace: [],
      oracles: [roundtripOracle(res, tmpl.expected, env, tmpl.assertField)],
    });
  }

  const selectedL1 = l1Pool.slice(0, limit);
  const selectedL2 = l2Pool.slice(0, l2Limit);
  const selectedL3 = l3Pool.slice(0, l3Limit);
  const selectedL4 = [...l4GenericPool.slice(0, l4Limit), ...l4CuratedPool];
  if (targetTaskCount && targetTaskCount > 0) {
    let total = selectedL1.length + selectedL2.length + selectedL3.length + selectedL4.length;
    if (total < targetTaskCount) appendUntil(selectedL4, l4GenericPool.slice(l4Limit), targetTaskCount - total + selectedL4.length);
    total = selectedL1.length + selectedL2.length + selectedL3.length + selectedL4.length;
    if (total < targetTaskCount) appendUntil(selectedL3, l3Pool.slice(l3Limit), targetTaskCount - total + selectedL3.length);
    total = selectedL1.length + selectedL2.length + selectedL3.length + selectedL4.length;
    if (total < targetTaskCount) appendUntil(selectedL2, l2Pool.slice(l2Limit), targetTaskCount - total + selectedL2.length);
    total = selectedL1.length + selectedL2.length + selectedL3.length + selectedL4.length;
    if (total < targetTaskCount) appendUntil(selectedL1, l1Pool.slice(limit), targetTaskCount - total + selectedL1.length);
  }

  const tasks: Task[] = [...selectedL1, ...selectedL2, ...selectedL3, ...selectedL4];

  let usedOperationTasks = false;
  let usedCuratedTasks = false;
  for (const tmpl of opts.operationTasks ?? []) {
    usedOperationTasks = true;
    tasks.push({
      id: tmpl.id,
      title: tmpl.title,
      difficulty: tmpl.difficulty,
      prompt: tmpl.prompt,
      allowed_surfaces: taskAllowedSurfacesForOperation(
        allowedSurfaces,
        opts.surfaceTaskPolicies,
        tmpl.id,
      ),
      na: false,
      depends_on: [],
      trace: tmpl.trace ?? [
        { type: "required_call", method: "POST", path: "/search", description: "operate the documented search endpoint" },
      ],
      oracles: [
        {
          type: "roundtrip",
          description: "read the reported URL back through a live content endpoint",
          readMethod: "POST",
          readPathTemplate: tmpl.readPath ?? "/contents",
          readBodyTemplate: { urls: ["{gid}"], text: false },
          assertField: "results.0.url",
          expected: tmpl.expectedUrl,
          ...(tmpl.expectedAny ? { expectedAny: tmpl.expectedAny } : {}),
          ...(tmpl.matchMode ? { matchMode: tmpl.matchMode } : {}),
        },
      ],
    });
  }

  for (const task of opts.curatedTasks ?? []) {
    usedCuratedTasks = true;
    tasks.push({
      ...task,
      title: task.title ?? task.id,
      allowed_surfaces: task.allowed_surfaces.length ? task.allowed_surfaces : allowedSurfaces,
      na: task.na ?? false,
      depends_on: task.depends_on ?? [],
      trace: task.trace ?? [],
    });
  }

  // Discovery (behavioral AEO) — NOT a separate run. This spec configures Phase
  // 0 of every profile (see harness/executor): the cold-start where the agent
  // must find the API base URL, auth, and create call by itself before doing any
  // task. We score its self-reported funnel against what the official docs
  // *should* let it find. The representative canonical call is the top resource's
  // create; there is no separate `outcome` — the L1-L4 tasks ARE the outcome.
  let discovery: TargetPack["discovery"];
  const discoveryRes = simple[0];
  if (opts.product && (discoveryRes || opts.discoveryCanonicalEndpoint)) {
    const officialDomains = [
      hostOf(opts.siteUrl ?? ""),
      ...(opts.docsUrls ?? []).map(hostOf),
    ].filter((h, i, a) => h && a.indexOf(h) === i);
    discovery = {
      product: opts.product,
      goal: opts.discoveryGoal ??
        `You are about to operate ${opts.product} programmatically. First work out, ` +
        `from scratch, how ${opts.product}'s public API works — its base URL, how to ` +
        `authenticate, the request/response shape, and how to create resources — then ` +
        `you will perform several tasks. You are NOT given any endpoint, base URL, or ` +
        `documentation link; find them yourself.`,
      official_domains: officialDomains,
      canonical_endpoint: opts.discoveryCanonicalEndpoint ?? `POST ${discoveryRes!.createPath}`,
      deprecated_markers: opts.deprecatedMarkers ?? [],
      auth_scheme: opts.authScheme ?? (opts.authMethod === "pat" ? "Bearer personal access token" : opts.authMethod ?? ""),
    };
  }

  // Auth, constant headers, and a sandbox-scope scaffold so a dropped-link pack
  // is structurally runnable: it passes schema validation and the review gate
  // shows the human exactly which env vars to fill — no hand-editing of shape.
  const product = opts.product ?? opts.packName;
  const slug = productSlug(product);
  const auth = deriveAuth(spec, opts, slug);
  const sandbox_scope = opts.sandboxScope ?? deriveScopeScaffold(product, slug, simple, composed);
  const headers = opts.headers ?? (spec.constantHeaders ?? {});

  return {
    name: opts.packName,
    version: opts.version ?? "0",
    standard_set_version: opts.standardSetVersion ?? `gen-${new Date().toISOString().slice(0, 10)}`,
    run_id: runId,
    // L4 templates are hand-curated (strongest-config authored), so the pack is
    // no longer purely rule-derived once they're included — record that.
    generated_by: opts.generatedBy ?? [
      GENERATED_BY,
      usedL4 ? "l4-curated" : "",
      usedCuratedTasks ? "task-curated" : "",
      usedOperationTasks ? "operation-curated" : "",
    ].filter(Boolean).join("+"),
    generator: opts.generator,
    // OpenAPI-derived packs are REST by construction.
    api_style: "rest",
    auth_method: opts.authMethod ?? "pat",
    auth,
    sandbox_scope,
    base_url: opts.baseUrl ?? spec.baseUrl,
    request_envelope: spec.requestEnvelope ?? undefined,
    response_envelope: spec.responseEnvelope ?? undefined,
    headers,
    site_url: opts.siteUrl ?? "",
    // Record the spec URL so verify-generated can run the content-quality audit
    // on the same target. Prefer an explicit opt; else the ingested source when
    // it's a real URL (a `fixture:` provenance isn't a fetchable spec).
    openapi_url:
      opts.openapiUrl ?? (/^https?:\/\//.test(spec.source ?? "") ? spec.source : ""),
    docs_urls: opts.docsUrls ?? [],
    static: opts.siteUrl
      ? { site_url: opts.siteUrl, docs_urls: opts.docsUrls ?? [], checks: [] }
      : undefined,
    discovery,
    surfaces: opts.surfaces,
    tasks,
  };
}

/** Serialize a generated pack to YAML with a freeze header. */
export function packToYaml(pack: TargetPack): string {
  const header =
    `# GENERATED — frozen standard_set. Do not hand-edit task ids/oracles after freeze.\n` +
    `# generated_by: ${pack.generated_by}\n` +
    `# standard_set_version: ${pack.standard_set_version}\n` +
    `# run_id: ${pack.run_id}\n`;
  return header + yamlStringify(pack);
}
