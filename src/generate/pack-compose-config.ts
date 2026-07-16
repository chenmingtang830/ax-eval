import { z } from "zod";
import { DiscoverySpecSchema } from "../schemas.js";
import { PublicHttpUrlSchema } from "./public-url.js";

const EnvNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "must name an environment variable");
const HeaderNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "must be a valid HTTP header name");
const OfficialDomainSchema = z.string().min(1).refine(
  (value) => !value.includes("://") && !value.includes("/"),
  "must be a hostname without a scheme or path",
);
const UrlTemplateSchema = z.string().refine((value) => {
  const unresolved = value.replace(/\$\{[A-Z][A-Z0-9_]*\}/g, "placeholder");
  return PublicHttpUrlSchema.safeParse(unresolved).success;
}, "must be a public http(s) URL or URL template without credentials");

const AuthConfigSchema = z.object({
  type: z.enum(["bearer", "api-key", "oauth", "none"]),
  env: z.union([EnvNameSchema, z.literal("")]),
  env_aliases: z.array(EnvNameSchema).default([]),
  verify_env: EnvNameSchema.optional(),
  verify_env_aliases: z.array(EnvNameSchema).default([]),
  header: HeaderNameSchema.optional(),
  extra_header: HeaderNameSchema.optional(),
}).strict().superRefine((auth, context) => {
  if (auth.type === "none" && auth.env) {
    context.addIssue({ code: "custom", path: ["env"], message: "unauthenticated targets must use an empty auth env" });
  }
  if (auth.type === "none" && (
    auth.env_aliases.length > 0
    || auth.verify_env
    || auth.verify_env_aliases.length > 0
    || auth.header
    || auth.extra_header
  )) {
    context.addIssue({ code: "custom", message: "unauthenticated targets cannot declare credential metadata" });
  }
  if (auth.type !== "none" && !auth.env) {
    context.addIssue({ code: "custom", path: ["env"], message: "authenticated targets require an auth env name" });
  }
  if (auth.header && auth.extra_header && auth.header.toLowerCase() === auth.extra_header.toLowerCase()) {
    context.addIssue({ code: "custom", path: ["extra_header"], message: "extra auth header must differ from auth header" });
  }
});

const ConstantHeadersSchema = z.record(z.string().min(1)).superRefine((headers, context) => {
  for (const [name, value] of Object.entries(headers)) {
    if (!HeaderNameSchema.safeParse(name).success) {
      context.addIssue({ code: "custom", path: [name], message: "invalid HTTP header name" });
    }
    if (/[\r\n]/.test(value)) {
      context.addIssue({ code: "custom", path: [name], message: "constant header values cannot contain line breaks" });
    }
    if (/authorization|api[-_]?key|token|secret|password|credential/i.test(name)) {
      context.addIssue({ code: "custom", path: [name], message: "credential headers belong in auth configuration" });
    }
    if (/\bBearer\s+|-----BEGIN |(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+:[^\s@]+@/i.test(value)) {
      context.addIssue({ code: "custom", path: [name], message: "constant header appears to contain a credential" });
    }
  }
});

const ComposeSurfaceAuthSchema = z.object({
  kind: z.enum(["inherit", "token", "oauth_app"]),
  token_env: EnvNameSchema.optional(),
  token_env_aliases: z.array(EnvNameSchema).default([]),
  client_id_env: EnvNameSchema.optional(),
  client_secret_env: EnvNameSchema.optional(),
  refresh_token_env: EnvNameSchema.optional(),
  token_url: PublicHttpUrlSchema.optional(),
  instructions: z.string().optional(),
}).strict().superRefine((auth, context) => {
  const oauthFields = [auth.client_id_env, auth.client_secret_env, auth.refresh_token_env, auth.token_url];
  if (auth.kind === "inherit" && (auth.token_env || auth.token_env_aliases.length > 0 || oauthFields.some(Boolean))) {
    context.addIssue({ code: "custom", message: "inherit surface auth cannot declare credential env vars" });
  }
  if (auth.kind === "token" && !auth.token_env) {
    context.addIssue({ code: "custom", path: ["token_env"], message: "token surface auth requires token_env" });
  }
  if (auth.kind === "token" && oauthFields.some(Boolean)) {
    context.addIssue({ code: "custom", message: "token surface auth cannot declare OAuth app fields" });
  }
  if (auth.kind === "oauth_app" && (auth.token_env || auth.token_env_aliases.length > 0)) {
    context.addIssue({ code: "custom", message: "OAuth app auth cannot declare token_env" });
  }
  if (auth.kind === "oauth_app" && oauthFields.some((field) => !field)) {
    context.addIssue({ code: "custom", message: "OAuth app auth requires client, refresh-token, and token URL env metadata" });
  }
});

const SandboxScopeSchema = z.object({
  name: z.string().min(1),
  env: EnvNameSchema,
  required: z.boolean().default(true),
  instructions: z.string().default(""),
  url_pattern: z.string().optional(),
}).strict();

const ComposeDiscoverySchema = DiscoverySpecSchema.extend({
  product: z.string().min(1),
  goal: z.string().min(1),
  official_domains: z.array(OfficialDomainSchema).min(1),
  canonical_endpoint: z.string().min(1),
  deprecated_markers: z.array(z.string().min(1)),
  auth_scheme: z.string().min(1),
}).strict();

export const PackComposeConfigSchema = z.object({
  base_url: z.union([UrlTemplateSchema, z.literal("")]),
  api_style: z.enum(["rest", "graphql"]).default("rest"),
  auth: AuthConfigSchema,
  sandbox_scope: z.array(SandboxScopeSchema).default([]),
  headers: ConstantHeadersSchema.default({}),
  discovery: ComposeDiscoverySchema.optional(),
  request_envelope: z.string().min(1).optional(),
  response_envelope: z.string().min(1).optional(),
  field_select_param: z.string().min(1).optional(),
  sql_conn: z.object({
    dialect: z.enum(["postgres", "mysql"]),
    connection_string_env: EnvNameSchema,
  }).strict().optional(),
  mongo_conn: z.object({
    connection_string_env: EnvNameSchema,
    database: z.string().min(1).optional(),
  }).strict().optional(),
  surface_auth: z.object({
    cli: ComposeSurfaceAuthSchema.optional(),
    sdk: ComposeSurfaceAuthSchema.optional(),
    mcp: ComposeSurfaceAuthSchema.optional(),
  }).strict().optional(),
}).strict();

export type PackComposeConfig = z.infer<typeof PackComposeConfigSchema>;

const EMBEDDED_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\b(?:sk|rk|pk)[_-](?:live|test)[_-][A-Za-z0-9_-]{16,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/i,
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:@]+:[^\s@]+@/i,
];

function assertNoEmbeddedSecrets(value: unknown, path = "config"): void {
  if (typeof value === "string") {
    if (EMBEDDED_SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error(`${path} appears to contain embedded credential material; use an env-var name instead`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEmbeddedSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertNoEmbeddedSecrets(child, `${path}.${key}`);
    }
  }
}

export function parsePackComposeConfig(rawConfig: unknown): PackComposeConfig {
  const config = PackComposeConfigSchema.parse(rawConfig);
  assertNoEmbeddedSecrets(config);
  const authHeaderNames = [config.auth.header ?? "Authorization", config.auth.extra_header]
    .filter((name): name is string => Boolean(name))
    .map((name) => name.toLowerCase());
  const conflictingHeader = Object.keys(config.headers).find((name) => authHeaderNames.includes(name.toLowerCase()));
  if (conflictingHeader) throw new Error(`constant header ${conflictingHeader} conflicts with auth configuration`);
  return config;
}
