/**
 * Generic auth'd HTTP client for oracle read-back against any target's REST API.
 * Generalizes the Asana-specific client: base_url + token + optional response
 * envelope (e.g. Asana wraps payloads in `{ "data": ... }`).
 *
 * Auth scheme is pack-declared so non-Bearer targets work: `bearer` sends
 * `Authorization: Bearer <token>` (Asana/Notion), `api-key` sends the raw token
 * (Linear/Monday send `Authorization: <token>` with NO `Bearer ` prefix), and
 * `none` omits it. `extraHeaders` carries pack constants like Notion's required
 * `Notion-Version`.
 */

export type AuthScheme = "bearer" | "api-key" | "oauth" | "none";

export type ApiStyle = "rest" | "graphql";

export class HttpApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "HttpApiError";
  }
}

export interface BearerClientOptions {
  baseUrl: string;
  token: string;
  /** Response envelope key to unwrap (e.g. "data"). */
  responseEnvelope?: string;
  /** How to present the credential. Default "bearer" (back-compat). */
  authScheme?: AuthScheme;
  /** Header the credential goes in. Default "Authorization". */
  authHeader?: string;
  /** Second header name to ALSO carry the raw token (e.g. Supabase's
   *  PostgREST requires both `Authorization: Bearer <key>` and `apikey: <key>`). */
  extraAuthHeader?: string;
  /** Constant headers every request must carry (e.g. Notion-Version). */
  extraHeaders?: Record<string, string>;
  /** Target API style. "rest" (default) uses `get`; "graphql" uses `graphql`
   *  (single POST endpoint). Recorded so callers can pick the read path. */
  apiStyle?: ApiStyle;
}

/** Resolve a dotted path against a nested object; undefined if absent. */
export function resolveDotted(obj: unknown, path: string): unknown {
  // "$" or "" addresses the whole node as-is — needed for endpoints that
  // return a bare JSON scalar (e.g. a Postgres function returning a number
  // directly via PostgREST's RPC endpoint), which has no key to dot into.
  if (path === "$" || path === "") return obj;
  let node: unknown = obj;
  for (const part of path.split(".")) {
    if (node !== null && typeof node === "object" && part in (node as object)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return node;
}

export class BearerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly envelope?: string;
  private readonly authScheme: AuthScheme;
  private readonly authHeader: string;
  private readonly extraAuthHeader: string | undefined;
  // The value sent under extraAuthHeader — separate from `token` because a
  // PostgREST-style API's `apikey` header must ALWAYS carry the project's own
  // key, even when `Authorization` is swapped to a per-user JWT (withToken)
  // to test row-level security. Defaults to `token` for the normal case
  // where both headers legitimately carry the same credential.
  private readonly extraAuthToken: string;
  private readonly extraHeaders: Record<string, string>;
  readonly apiStyle: ApiStyle;

  constructor(opts: BearerClientOptions & { extraAuthToken?: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.envelope = opts.responseEnvelope;
    this.authScheme = opts.authScheme ?? "bearer";
    this.authHeader = opts.authHeader ?? "Authorization";
    this.extraAuthHeader = opts.extraAuthHeader;
    this.extraAuthToken = opts.extraAuthToken ?? opts.token;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.apiStyle = opts.apiStyle ?? "rest";
  }

  /** A client sharing this one's config but a different PRIMARY credential
   *  (the Authorization header) — e.g. a per-user JWT the executor reported,
   *  to verify identity-scoped access control (RLS) where the pack's own
   *  admin-level credential would bypass the policy being tested and always
   *  see everything. The extraAuthHeader (e.g. PostgREST's `apikey`) keeps
   *  the ORIGINAL project credential — swapping it too would send an invalid
   *  API key, since that header identifies the PROJECT, not the end user. */
  withToken(token: string): BearerClient {
    return new BearerClient({
      baseUrl: this.baseUrl,
      token,
      responseEnvelope: this.envelope,
      authScheme: this.authScheme,
      authHeader: this.authHeader,
      extraAuthHeader: this.extraAuthHeader,
      extraAuthToken: this.extraAuthToken,
      extraHeaders: this.extraHeaders,
      apiStyle: this.apiStyle,
    });
  }

  /** A client sharing this one's auth/header behavior but targeting a different
   *  base URL — used for vendors like Convex where task-level execution may
   *  legitimately move onto a preview deployment URL discovered during the run. */
  withBaseUrl(baseUrl: string): BearerClient {
    return new BearerClient({
      baseUrl,
      token: this.token,
      responseEnvelope: this.envelope,
      authScheme: this.authScheme,
      authHeader: this.authHeader,
      extraAuthHeader: this.extraAuthHeader,
      extraAuthToken: this.extraAuthToken,
      extraHeaders: this.extraHeaders,
      apiStyle: this.apiStyle,
    });
  }

  /** Pull a human-readable message out of an error body across the several
   *  shapes vendors use: Notion/GraphQL-style `{errors: [{message}]}`, a
   *  bare `{error: "..."}` string, or PostgREST/plain-REST's `{message}`. */
  private static extractErrorMessage(json: Record<string, unknown>, res: Response): string {
    const errors = json.errors as Array<{ message?: string }> | undefined;
    if (errors?.[0]?.message) return errors[0].message;
    if (typeof json.error === "string") return json.error;
    if (typeof json.message === "string") return json.message;
    return res.statusText || `HTTP ${res.status}`;
  }

  /** Resolve a path against baseUrl — UNLESS it's already an absolute URL
   *  (some oracle checks hit a different host entirely, e.g. Supabase's
   *  management API at api.supabase.com vs the project's own subdomain). */
  private resolveUrl(path: string): URL {
    if (/^https?:\/\//i.test(path)) return new URL(path);
    return new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
  }

  /** Auth + constant headers for every request, per the pack's declared scheme. */
  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", ...this.extraHeaders };
    if (this.authScheme === "bearer" || this.authScheme === "oauth") {
      h[this.authHeader] = `Bearer ${this.token}`;
    } else if (this.authScheme === "api-key") {
      h[this.authHeader] = this.token; // raw token, no "Bearer " (Linear/Monday)
    }
    if (this.extraAuthHeader) h[this.extraAuthHeader] = this.extraAuthToken; // e.g. Supabase's `apikey`
    return h;
  }

  /** GET a path (relative to baseUrl), unwrapping the response envelope. */
  async get<T = unknown>(path: string, query?: Record<string, string>): Promise<T> {
    const url = this.resolveUrl(path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: this.headers() });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new HttpApiError(`GET ${path}: ${BearerClient.extractErrorMessage(json, res)}`, res.status, json);
    }
    if (this.envelope && this.envelope in json) return json[this.envelope] as T;
    return json as T;
  }

  /** POST JSON to a path (relative to baseUrl), unwrapping the response envelope.
   *  Tolerates an empty response body on success (some management-style APIs,
   *  e.g. Convex's delete-deployment, return 200 with no body). */
  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const url = this.resolveUrl(path);
    const res = await fetch(url, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let json: Record<string, unknown> | undefined;
    if (text) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        if (!res.ok) throw new HttpApiError(`POST ${path}: ${res.statusText}`, res.status, text);
      }
    }
    if (!res.ok) {
      throw new HttpApiError(`POST ${path}: ${json ? BearerClient.extractErrorMessage(json, res) : res.statusText}`, res.status, json ?? text);
    }
    if (!json) return undefined as T;
    if (this.envelope && this.envelope in json) return json[this.envelope] as T;
    return json as T;
  }

  /** DELETE a path (relative to baseUrl). Throws HttpApiError on a non-2xx, so
   *  teardown (reset) can report per-resource failures. */
  async del(path: string): Promise<void> {
    const url = this.resolveUrl(path);
    const res = await fetch(url, { method: "DELETE", headers: this.headers() });
    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        /* no body */
      }
      const errors = (body as { errors?: Array<{ message?: string }> } | undefined)?.errors;
      throw new HttpApiError(`DELETE ${path}: ${errors?.[0]?.message ?? res.statusText}`, res.status, body);
    }
  }

  /**
   * POST a GraphQL query (+ optional variables) to `baseUrl` as JSON, honoring
   * the same auth scheme + constant headers as `get`. GraphQL responses are
   * `{ data, errors }`: we throw on a transport error OR a non-empty `errors`
   * array, and otherwise return the parsed `data`. Single-endpoint GraphQL
   * SaaS APIs (Linear, Monday) read back created resources through this.
   */
  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(new URL(this.baseUrl), {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (!res.ok) {
      const msg = json.errors?.[0]?.message ?? res.statusText;
      throw new HttpApiError(`GraphQL: ${msg}`, res.status, json);
    }
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      const msg = json.errors.map((e) => e.message ?? "error").join("; ");
      throw new HttpApiError(`GraphQL errors: ${msg}`, res.status, json);
    }
    return json.data as T;
  }
}
