import { z } from "zod";

// Models reliably reach for "postgresql" (the more common spelling) despite
// the schema calling for "postgres". Normalize the equivalent spelling at the
// reusable data-contract boundary.
export const OracleSqlDialectSchema = z.preprocess(
  (value) => (value === "postgresql" ? "postgres" : value),
  z.enum(["postgres", "mysql"]),
);

export const OracleCheckSchema = z
  .object({
    read_method: z.enum(["GET", "POST"]).nullish().transform((value) => value ?? undefined),
    read_path_template: z.string().nullish().transform((value) => value ?? undefined),
    read_body_template: z.unknown().optional(),
    sql_dialect: OracleSqlDialectSchema.nullish().transform((value) => value ?? undefined),
    sql_query: z.string().nullish().transform((value) => value ?? undefined),
    probe_sql_query: z.string().nullish().transform((value) => value ?? undefined),
    probe_assert_field: z.string().nullish().transform((value) => value ?? undefined),
    probe_expected: z.union([z.string(), z.number(), z.boolean()]).nullish().transform((value) => value ?? undefined),
    probe_expect_error: z.boolean().nullish().transform((value) => value ?? undefined),
    mongo_query: z.object({
      database: z.string(),
      collection: z.string(),
      operation: z.enum(["count", "findOne", "aggregate", "listCollections"]),
      filter: z.unknown().optional(),
      projection: z.unknown().optional(),
      sort: z.unknown().optional(),
      pipeline: z.array(z.unknown()).optional(),
    }).optional(),
    assert_field: z.string().min(1),
    assert_outcome: z.enum(["value", "error"]).nullish().transform((value) => value ?? undefined),
    expected_http_statuses: z.array(z.number().int()).nullish().transform((value) => value ?? undefined),
    expected: z.union([z.string(), z.number(), z.boolean()]),
    auth_field: z.string().nullish().transform((value) => value ?? undefined),
    sql_conn_field: z.string().nullish().transform((value) => value ?? undefined),
    sql_role_field: z.string().nullish().transform((value) => value ?? undefined),
    sql_role_template: z.string().nullish().transform((value) => value ?? undefined),
    description: z.string().default(""),
  })
  .refine(
    (check) => [check.read_path_template, check.sql_query, check.mongo_query].filter(Boolean).length === 1,
    { message: "check must set exactly one of read_path_template, sql_query, or mongo_query" },
  );
export type OracleCheck = z.infer<typeof OracleCheckSchema>;

export const OracleExtractSurfaceIdSchema = z.enum(["api", "sdk", "cli", "mcp"]);
export type OracleExtractSurfaceId = z.infer<typeof OracleExtractSurfaceIdSchema>;

export const OracleExtractItemSchema = z.object({
  task_id: z.string(),
  na: z.boolean(),
  na_reason: z.string().nullish().transform((value) => value ?? undefined),
  na_surfaces: z.array(OracleExtractSurfaceIdSchema).default([]),
  na_surfaces_reason: z.string().nullish().transform((value) => value ?? undefined),
  support_reference: z.string().nullish().transform((value) => value ?? undefined),
  checks: z.array(OracleCheckSchema).default([]),
});
export type OracleExtractItem = z.infer<typeof OracleExtractItemSchema>;

export const OracleVendorConfigSchema = z.object({
  base_url: z.string(),
  auth_type: z.enum(["bearer", "api-key", "oauth", "none"]),
  auth_header: z.string().nullish().transform((value) => value ?? undefined),
  auth_env: z.string(),
  extra_auth_header: z.string().nullish().transform((value) => value ?? undefined),
  sql_dialect: OracleSqlDialectSchema.nullish().transform((value) => value ?? undefined),
  sql_connection_env: z.string().nullish().transform((value) => value ?? undefined),
  mongo_connection_env: z.string().nullish().transform((value) => value ?? undefined),
  mongo_database: z.string().nullish().transform((value) => value ?? undefined),
});
export type OracleVendorConfig = z.infer<typeof OracleVendorConfigSchema>;

export const OracleExtractResultSchema = z.object({
  vendor: z.string(),
  category: z.string(),
  slug: z.string(),
  suite_name: z.string(),
  extracted_at: z.string(),
  vendor_config: OracleVendorConfigSchema,
  tasks: z.array(OracleExtractItemSchema),
});
export type OracleExtractResult = z.infer<typeof OracleExtractResultSchema>;
