/**
 * Generic OpenAPI ingest: parse a spec and derive a CRUD resource model that
 * downstream generation turns into tasks + programmatic oracles.
 *
 * Deliberately light (no model, no full validator): resolve local `$ref`s with
 * a cycle guard, enumerate path/method operations, and pair create (POST on a
 * collection) with read (GET on `/collection/{param}`). Identity field and
 * envelope are heuristics with safe fallbacks so the engine stays target-generic.
 */
import { parse as parseYaml } from "yaml";

export interface CrudResource {
  /** Collection name, e.g. "tasks" (from the collection path segment). */
  name: string;
  createPath: string; // "/tasks" or sub-collection "/tasks/{task_gid}/subtasks"
  createOp: string;
  readPath: string; // "/tasks/{task_gid}"
  readParam: string; // "task_gid"
  /** Field asserted on read-back; heuristic, defaults to "name". */
  identityField: string;
  createFields: string[];
  /** Parent resources implied by path params on the create path. */
  dependsOn: string[];
  /** The item path (`readPath`) exposes a PATCH or PUT — the resource can be
   *  mutated in place, so a create→update→read-back lifecycle task is derivable. */
  canUpdate: boolean;
  /** The item path exposes a DELETE. */
  canDelete: boolean;
}

/** Auth derived from `components.securitySchemes` + global `security`. */
export type IngestedAuthType = "bearer" | "api-key" | "oauth" | "none";
export interface IngestedAuth {
  type: IngestedAuthType;
  /** Header the credential rides in (api-key → its declared name; http/oauth →
   *  Authorization; none → null). */
  header: string | null;
}

export interface IngestedSpec {
  source: string;
  title: string;
  baseUrl: string;
  requestEnvelope: string | null;
  responseEnvelope: string | null;
  resources: CrudResource[];
  /** Auth scheme the API declares (best-effort; `none` when undeclared). */
  auth: IngestedAuth;
  /** Constant required headers (fixed value / single-enum / default), excluding
   *  the auth header. E.g. an API-version header. `{}` when none. */
  constantHeaders: Record<string, string>;
}

type Json = Record<string, unknown>;

const IDENTITY_PREFERENCE = ["name", "title", "label", "text", "summary"];
const MAX_REF_DEPTH = 20;

/** Resolve a local `#/a/b/c` ref against the root document. */
function resolveRef(root: Json, ref: string, seen = new Set<string>()): unknown {
  if (!ref.startsWith("#/") || seen.has(ref) || seen.size > MAX_REF_DEPTH) return undefined;
  seen.add(ref);
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node && typeof node === "object" && key in (node as object)) {
      node = (node as Json)[key];
    } else {
      return undefined;
    }
  }
  if (node && typeof node === "object" && typeof (node as Json).$ref === "string") {
    return resolveRef(root, (node as Json).$ref as string, seen);
  }
  return node;
}

function deref(root: Json, node: unknown, seen = new Set<string>()): Json | undefined {
  if (!node || typeof node !== "object") return undefined;
  const obj = node as Json;
  if (typeof obj.$ref === "string") {
    const r = resolveRef(root, obj.$ref, seen);
    return r && typeof r === "object" ? (r as Json) : undefined;
  }
  return obj;
}

/**
 * Find the create body's property names + an envelope key. Asana wraps the
 * payload in `data`; if the request schema has a single object property whose
 * own schema carries the real fields, treat that key as the envelope.
 */
function analyzeSchemaIdentity(
  root: Json,
  schema: Json | undefined,
): { fields: string[]; envelope: string | null; identity: string } {
  const empty = { fields: [] as string[], envelope: null as string | null, identity: "name" };
  if (!schema) return empty;
  let envelope: string | null = null;
  let props = deref(root, schema.properties) as Json | undefined;
  // Unwrap a single-object envelope (e.g. { data: { <real fields> } }).
  if (props) {
    const keys = Object.keys(props);
    if (keys.length === 1) {
      const inner = deref(root, props[keys[0]!]);
      const innerProps = deref(root, inner?.properties) as Json | undefined;
      if (innerProps && Object.keys(innerProps).length > 0) {
        envelope = keys[0]!;
        schema = inner!;
        props = innerProps;
      }
    }
  }
  const fields = props ? Object.keys(props) : [];
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const identity =
    IDENTITY_PREFERENCE.find((p) => fields.includes(p)) ??
    required.find((r) => {
      const ps = deref(root, props?.[r]);
      return ps?.type === "string";
    }) ??
    "name";
  return { fields, envelope, identity };
}

function analyzeCreateBody(
  root: Json,
  op: Json,
): { fields: string[]; envelope: string | null; identity: string } {
  const rb = deref(root, op.requestBody);
  const content = rb?.content as Json | undefined;
  const appJson = content?.["application/json"] as Json | undefined;
  return analyzeSchemaIdentity(root, deref(root, appJson?.schema));
}

function analyzeReadBody(
  root: Json,
  op: Json,
): { fields: string[]; envelope: string | null; identity: string } {
  const responses = deref(root, op.responses) as Json | undefined;
  const ok =
    deref(root, responses?.["200"]) ??
    deref(root, responses?.["201"]) ??
    deref(root, responses?.default);
  const content = deref(root, ok?.content) as Json | undefined;
  const appJson = content?.["application/json"] as Json | undefined;
  return analyzeSchemaIdentity(root, deref(root, appJson?.schema));
}

/** Last `{param}`-free segment of a path, e.g. "/tasks/{gid}" → "tasks". */
function collectionName(path: string): string | null {
  const segs = path.split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    if (!segs[i]!.startsWith("{")) return segs[i]!;
  }
  return null;
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

function isAsyncRequestPath(path: string, coll: string): boolean {
  return coll.toLowerCase() === "export" || /\/exports?(?:\/|$)/i.test(path);
}

/**
 * Choose the item-read endpoint that best matches a create path. Large specs
 * (e.g. Stripe) expose several GET-by-id paths under the same leaf collection
 * name — `/v1/accounts/{account}` AND `/v1/financial_connections/accounts/{id}`.
 * Prefer the canonical `<createPath>/{param}`; else the read sharing the longest
 * leading path with the create, so we don't pair a create with an unrelated GET
 * that merely shares the collection's leaf name.
 */
function pickRead(
  createPath: string,
  candidates: Array<{ path: string; param: string; op: Json }>,
): { path: string; param: string; op: Json } | undefined {
  if (candidates.length <= 1) return candidates[0];
  const exact = candidates.find((r) => r.path === `${createPath}/{${r.param}}`);
  if (exact) return exact;
  const segs = (p: string) => p.split("/").filter(Boolean);
  const cSegs = segs(createPath);
  const shared = (p: string) => {
    const rSegs = segs(p);
    let n = 0;
    while (n < cSegs.length && n < rSegs.length && cSegs[n] === rSegs[n]) n++;
    return n;
  };
  return [...candidates].sort(
    (a, b) => shared(b.path) - shared(a.path) || a.path.length - b.path.length,
  )[0];
}

/** Classify one securityScheme object into our coarse auth model. */
function classifyScheme(scheme: Json | undefined): IngestedAuth {
  if (!scheme) return { type: "none", header: null };
  const t = String(scheme.type ?? "").toLowerCase();
  if (t === "http") return { type: "bearer", header: "Authorization" };
  if (t === "apikey") {
    const inLoc = String(scheme.in ?? "").toLowerCase();
    const name = typeof scheme.name === "string" ? scheme.name : null;
    return { type: "api-key", header: inLoc === "header" ? name : null };
  }
  if (t === "oauth2" || t === "openidconnect") return { type: "oauth", header: "Authorization" };
  return { type: "none", header: null };
}

/** Derive auth from `components.securitySchemes`, preferring the scheme named by
 *  the global `security` requirement, else the first defined scheme. */
function parseSecurity(root: Json): IngestedAuth {
  const schemes = deref(root, (root.components as Json | undefined)?.securitySchemes);
  if (!schemes) return { type: "none", header: null };
  const names = Object.keys(schemes);
  const security = root.security as Array<Json> | undefined;
  let chosen: string | undefined;
  if (Array.isArray(security) && security.length > 0 && security[0] && typeof security[0] === "object") {
    chosen = Object.keys(security[0]).find((n) => n in schemes);
  }
  chosen ??= names[0];
  return chosen ? classifyScheme(deref(root, schemes[chosen]) ?? (schemes[chosen] as Json)) : { type: "none", header: null };
}

/** A header/server-variable's fixed value: `const`, a single-entry `enum`, or a
 *  `default`. Null when the value isn't pinned to a constant. */
function constValue(schema: Json | undefined): string | null {
  if (!schema) return null;
  if (typeof schema.const === "string") return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length === 1 && typeof schema.enum[0] === "string") {
    return schema.enum[0];
  }
  if (typeof schema.default === "string") return schema.default;
  return null;
}

/** Substitute server-URL `{var}`s that resolve to a constant (single-enum or a
 *  default), so the base URL downstream is concrete. */
function resolveServerUrl(server: { url?: string; variables?: Json } | undefined): string {
  let url = server?.url ?? "";
  const vars = server?.variables;
  if (vars && typeof vars === "object") {
    for (const [name, vRaw] of Object.entries(vars)) {
      const val = constValue(vRaw as Json);
      if (val !== null) url = url.split(`{${name}}`).join(val);
    }
  }
  return url;
}

/** Collect constant required header parameters across every operation (e.g. an
 *  API-version header), excluding the auth header. */
function parseConstantHeaders(root: Json, paths: Json, authHeader: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  const consider = (paramsRaw: unknown): void => {
    if (!Array.isArray(paramsRaw)) return;
    for (const pRaw of paramsRaw) {
      const p = deref(root, pRaw);
      if (!p || String(p.in ?? "").toLowerCase() !== "header") continue;
      const name = typeof p.name === "string" ? p.name : null;
      if (!name || (authHeader && name.toLowerCase() === authHeader.toLowerCase()) || name in out) continue;
      const val = constValue(deref(root, p.schema));
      if (val !== null) out[name] = val;
    }
  };
  for (const itemRaw of Object.values(paths)) {
    const item = itemRaw as Json;
    consider(item.parameters);
    for (const m of ["get", "post", "put", "patch", "delete"]) consider((item[m] as Json | undefined)?.parameters);
  }
  return out;
}

export function parseSpec(text: string, source = "spec"): IngestedSpec {
  const root = parseYaml(text) as Json;
  const info = (root.info ?? {}) as Json;
  const servers = (root.servers ?? []) as Array<{ url?: string; variables?: Json }>;
  const baseUrl = resolveServerUrl(servers[0]);
  const paths = (root.paths ?? {}) as Json;
  const auth = parseSecurity(root);
  const constantHeaders = parseConstantHeaders(root, paths, auth.header);

  // Index collection-level POST ops and item-level GET ops.
  const creates: Array<{ path: string; op: Json; coll: string }> = [];
  // coll → ALL item-read endpoints under that leaf name (a big spec can have
  // several); the create↔read pairing below picks the best match per create.
  const reads = new Map<string, Array<{ path: string; param: string; op: Json }>>();
  // path → set of HTTP methods defined on it (lower-case), so we can tell whether
  // a chosen item-read path also exposes update (patch/put) or delete.
  const methodsByPath = new Map<string, Set<string>>();

  for (const [path, itemRaw] of Object.entries(paths)) {
    const item = itemRaw as Json;
    const params = pathParams(path);
    const post = item.post as Json | undefined;
    const get = item.get as Json | undefined;
    methodsByPath.set(
      path,
      new Set(["get", "post", "put", "patch", "delete"].filter((m) => item[m])),
    );
    const coll = collectionName(path);
    if (!coll) continue;
    const endsWithParam = path.trimEnd().endsWith("}");

    if (post && !endsWithParam) {
      creates.push({ path, op: post, coll });
    }
    if (get && endsWithParam && params.length >= 1) {
      // item read: /coll/{param}
      const seg = path.split("/").filter(Boolean);
      const lastParam = seg[seg.length - 1]!;
      if (lastParam.startsWith("{")) {
        const itemColl = seg[seg.length - 2];
        if (itemColl && !itemColl.startsWith("{")) {
          const list = reads.get(itemColl) ?? [];
          list.push({ path, param: params[params.length - 1]!, op: get });
          reads.set(itemColl, list);
        }
      }
    }
  }

  let envelope: string | null = null;
  const resources: CrudResource[] = [];
  for (const { path, op, coll } of creates) {
    if (isAsyncRequestPath(path, coll)) continue;
    const read = pickRead(path, reads.get(coll) ?? []);
    if (!read) continue; // need a read-back endpoint for a programmatic oracle
    const { fields, envelope: env, identity } = analyzeCreateBody(root, op);
    const readBody = analyzeReadBody(root, read.op);
    if (env && !envelope) envelope = env;
    const itemMethods = methodsByPath.get(read.path) ?? new Set<string>();
    // Dependencies: parent resources implied by `{x_gid}` params on the create path.
    const dependsOn = pathParams(path)
      .map((p) => p.replace(/_?gid$/i, "").replace(/_?id$/i, ""))
      .filter(Boolean)
      .map((base) => `${base}s`.replace(/ss$/, "s"));
    resources.push({
      name: coll,
      createPath: path,
      createOp: typeof op.operationId === "string" ? op.operationId : `create_${coll}`,
      readPath: read.path,
      readParam: read.param,
      identityField: readBody.fields.length > 0 ? readBody.identity : identity,
      createFields: fields,
      dependsOn,
      canUpdate: itemMethods.has("patch") || itemMethods.has("put"),
      canDelete: itemMethods.has("delete"),
    });
  }

  return {
    source,
    title: typeof info.title === "string" ? info.title : source,
    baseUrl,
    requestEnvelope: envelope,
    responseEnvelope: envelope,
    resources,
    auth,
    constantHeaders,
  };
}
