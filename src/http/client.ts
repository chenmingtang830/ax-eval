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
import { DOTTED_MISSING, resolveDottedPath } from "../dotted.js";

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
  /** Constant headers every request must carry (e.g. Notion-Version). */
  extraHeaders?: Record<string, string>;
  /** Target API style. "rest" (default) uses `get`; "graphql" uses `graphql`
   *  (single POST endpoint). Recorded so callers can pick the read path. */
  apiStyle?: ApiStyle;
}

/** Resolve a dotted path against a nested object; undefined if absent. */
export function resolveDotted(obj: unknown, path: string): unknown {
  const value = resolveDottedPath(obj, path);
  return value === DOTTED_MISSING ? undefined : value;
}

export class BearerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly envelope?: string;
  private readonly authScheme: AuthScheme;
  private readonly authHeader: string;
  private readonly extraHeaders: Record<string, string>;
  readonly apiStyle: ApiStyle;

  constructor(opts: BearerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.envelope = opts.responseEnvelope;
    this.authScheme = opts.authScheme ?? "bearer";
    this.authHeader = opts.authHeader ?? "Authorization";
    this.extraHeaders = opts.extraHeaders ?? {};
    this.apiStyle = opts.apiStyle ?? "rest";
  }

  /** Auth + constant headers for every request, per the pack's declared scheme. */
  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", ...this.extraHeaders };
    if (this.authScheme === "bearer" || this.authScheme === "oauth") {
      h[this.authHeader] = `Bearer ${this.token}`;
    } else if (this.authScheme === "api-key") {
      h[this.authHeader] = this.token; // raw token, no "Bearer " (Linear/Monday)
    }
    return h;
  }

  /** GET a path (relative to baseUrl), unwrapping the response envelope. */
  async get<T = unknown>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: this.headers() });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const errors = json.errors as Array<{ message?: string }> | undefined;
      const msg = errors?.[0]?.message ?? res.statusText;
      throw new HttpApiError(`GET ${path}: ${msg}`, res.status, json);
    }
    if (this.envelope && this.envelope in json) return json[this.envelope] as T;
    return json as T;
  }

  /** POST JSON to a path (relative to baseUrl), unwrapping the response envelope. */
  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    const res = await fetch(url, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const errors = json.errors as Array<{ message?: string }> | undefined;
      const msg = errors?.[0]?.message ?? (typeof json.error === "string" ? json.error : res.statusText);
      throw new HttpApiError(`POST ${path}: ${msg}`, res.status, json);
    }
    if (this.envelope && this.envelope in json) return json[this.envelope] as T;
    return json as T;
  }

  /** DELETE a path (relative to baseUrl). Throws HttpApiError on a non-2xx, so
   *  teardown (reset) can report per-resource failures. */
  async del(path: string): Promise<void> {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
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
