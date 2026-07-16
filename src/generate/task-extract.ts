import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { assertArtifactSegment } from "./artifact-path.js";
import { assertReadOnlyMongoQuery } from "./mongo-verify.js";
import { PublicHttpUrlSchema, urlUsesOfficialHost } from "./public-url.js";
import { assertReadOnlySql } from "./sql-verify.js";
import { parseStructuredOutput, runStructuredGenerator, type StructuredGenerator } from "./structured-output.js";
import type { CapabilityExtractResult } from "./capability-extract.js";
import type { Suite, SuiteTask } from "./suite.js";
import type { SurfaceExtractResult } from "./surface-extract.js";
import type { ResolveResult } from "./vendor-resolve.js";

const SurfaceIdSchema = z.enum(["api", "cli", "sdk", "mcp"]);
const ExpectedValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.unknown()),
]);
const EvidenceSchema = z.object({
  doc_url: PublicHttpUrlSchema,
  quote: z.string().min(1),
}).strict();

const OracleCommon = {
  type: z.literal("roundtrip"),
  assertField: z.string().min(1),
  expected: ExpectedValueSchema,
  expectedAny: z.array(ExpectedValueSchema).optional(),
  matchMode: z.enum(["exact", "url"]).optional(),
  responseEnvelope: z.string().min(1).optional(),
  description: z.string().min(1),
};

const RestOracleSchema = z.object({
  ...OracleCommon,
  readMethod: z.enum(["GET", "POST"]).default("GET"),
  readPathTemplate: z.string()
    .regex(/^\/(?!\/)/, "must be a relative API path beginning with one slash")
    .refine((value) => !/[\\\n\r]/.test(value), "must not contain backslashes or control characters"),
  readBodyTemplate: z.unknown().optional(),
}).strict().superRefine((oracle, context) => {
  if (oracle.readMethod === "GET" && oracle.readBodyTemplate !== undefined) {
    context.addIssue({ code: "custom", path: ["readBodyTemplate"], message: "GET verification cannot declare a request body" });
  }
});

const GraphqlOracleSchema = z.object({
  ...OracleCommon,
  readQueryTemplate: z.string().min(1).refine(
    (value) => !/\b(?:mutation|subscription)\b/i.test(value),
    "must be a read-only GraphQL query",
  ),
}).strict();

const SqlOracleSchema = z.object({
  ...OracleCommon,
  sqlDialect: z.enum(["postgres", "mysql"]),
  sqlQuery: z.string().min(1),
}).strict().superRefine((oracle, context) => {
  try {
    assertReadOnlySql(oracle.sqlQuery);
  } catch (error) {
    context.addIssue({ code: "custom", path: ["sqlQuery"], message: error instanceof Error ? error.message : String(error) });
  }
});

const MongoOracleSchema = z.object({
  ...OracleCommon,
  mongoQuery: z.object({
    database: z.string(),
    collection: z.string().min(1),
    operation: z.enum(["count", "findOne", "aggregate", "listCollections"]),
    filter: z.unknown().optional(),
    projection: z.unknown().optional(),
    sort: z.unknown().optional(),
    pipeline: z.array(z.unknown()).optional(),
  }).strict(),
}).strict().superRefine((oracle, context) => {
  try {
    assertReadOnlyMongoQuery(oracle.mongoQuery);
  } catch (error) {
    context.addIssue({ code: "custom", path: ["mongoQuery"], message: error instanceof Error ? error.message : String(error) });
  }
});

const ExtractedOracleSchema = z.union([
  RestOracleSchema,
  GraphqlOracleSchema,
  SqlOracleSchema,
  MongoOracleSchema,
]);

const GeneratedTaskBaseSchema = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  allowed_surfaces: z.array(SurfaceIdSchema).refine(
    (surfaces) => new Set(surfaces).size === surfaces.length,
    "allowed surfaces must be unique",
  ),
  na: z.boolean(),
  na_reason: z.string().min(1).nullable(),
  support_evidence: z.array(EvidenceSchema).min(1),
  oracles: z.array(ExtractedOracleSchema),
}).strict();

function validateGeneratedTask(task: z.infer<typeof GeneratedTaskBaseSchema>, context: z.RefinementCtx): void {
  if (task.na) {
    if (!task.na_reason) context.addIssue({ code: "custom", path: ["na_reason"], message: "N/A tasks require a reason" });
    if (task.oracles.length > 0) context.addIssue({ code: "custom", path: ["oracles"], message: "N/A tasks cannot declare oracles" });
    return;
  }
  if (!task.prompt.trim()) context.addIssue({ code: "custom", path: ["prompt"], message: "supported tasks require a prompt" });
  if (task.na_reason) context.addIssue({ code: "custom", path: ["na_reason"], message: "supported tasks cannot declare an N/A reason" });
  if (task.oracles.length === 0) context.addIssue({ code: "custom", path: ["oracles"], message: "supported tasks require a read-back oracle" });
}

const GeneratedTaskSchema = GeneratedTaskBaseSchema.superRefine(validateGeneratedTask);
const PersistedTaskSchema = GeneratedTaskBaseSchema.extend({
  title: z.string().min(1),
  difficulty: z.enum(["L1", "L2", "L3", "L4"]),
}).strict().superRefine(validateGeneratedTask);

const GeneratedResultSchema = z.object({ tasks: z.array(GeneratedTaskSchema).min(1) }).strict();
const TaskExtractSchema = z.object({
  vendor: z.string().min(1),
  slug: z.string().min(1),
  suite_name: z.string().min(1),
  suite_version: z.number().int().positive(),
  extracted_at: z.string().datetime(),
  extractor: z.string().min(1),
  tasks: z.array(PersistedTaskSchema).min(1),
}).strict();

export type TaskExtractResult = z.infer<typeof TaskExtractSchema>;

function availableSurfaces(surfaceExtract: SurfaceExtractResult): Set<string> {
  return new Set([
    "api",
    ...(surfaceExtract.cli ? ["cli"] : []),
    ...(surfaceExtract.sdk ? ["sdk"] : []),
    ...(surfaceExtract.mcp ? ["mcp"] : []),
  ]);
}

function validateTaskSet(
  generatedTasks: z.infer<typeof GeneratedTaskSchema>[],
  suite: Suite,
  surfaces: Set<string>,
  officialRoots: readonly (string | null)[],
): void {
  const generatedById = new Map<string, z.infer<typeof GeneratedTaskSchema>>();
  for (const task of generatedTasks) {
    if (generatedById.has(task.id)) throw new Error(`task extract returned duplicate task ${task.id}`);
    generatedById.set(task.id, task);
  }
  const expectedIds = new Set(suite.tasks.map((task) => task.id));
  const missing = suite.tasks.filter((task) => !generatedById.has(task.id)).map((task) => task.id);
  const extra = generatedTasks.filter((task) => !expectedIds.has(task.id)).map((task) => task.id);
  if (missing.length || extra.length) {
    throw new Error(`task extract mismatch: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`);
  }

  for (const canonical of suite.tasks) {
    const task = generatedById.get(canonical.id)!;
    const allowedBySuite = new Set(canonical.allowed_surfaces.length > 0 ? canonical.allowed_surfaces : surfaces);
    for (const surface of task.allowed_surfaces) {
      if (!surfaces.has(surface)) throw new Error(`task ${task.id} uses unavailable surface ${surface}`);
      if (!allowedBySuite.has(surface)) throw new Error(`task ${task.id} uses non-canonical surface ${surface}`);
    }
    if (!task.na && canonical.allowed_surfaces.length > 0 && task.allowed_surfaces.length === 0) {
      throw new Error(`task ${task.id} cannot use an empty surface list because the canonical suite restricts surfaces`);
    }
    if (!task.na && canonical.intent.includes("{ns}") && !task.prompt.includes("{ns}")) {
      throw new Error(`task ${task.id} dropped the required {ns} namespace placeholder`);
    }
    for (const evidence of task.support_evidence) {
      if (!urlUsesOfficialHost(evidence.doc_url, officialRoots)) {
        throw new Error(`task ${task.id} cites non-official host ${evidence.doc_url}`);
      }
    }
  }
}

function promptTask(task: SuiteTask): object {
  return {
    id: task.id,
    title: task.title,
    difficulty: task.difficulty,
    skill: task.skill,
    intent: task.intent,
    oracle_hint: task.oracle_hint,
    allowed_surfaces: task.allowed_surfaces,
    na_examples: task.na_examples,
  };
}

export function buildTaskExtractPrompt(
  vendor: ResolveResult,
  suite: Suite,
  capabilities: CapabilityExtractResult,
  surfaces: SurfaceExtractResult,
): string {
  return [
    `Author the ${suite.name} v${suite.version} benchmark tasks for ${vendor.vendor}.`,
    `Use only official documentation rooted at ${vendor.docs_url}; cite official evidence for every support decision.`,
    "Return exactly one task per canonical task id, preserving ids and using explicit na=true when unsupported.",
    "Never put credentials, tokens, passwords, connection strings, or secret values in the output.",
    "Verification must be independent, deterministic read-back through exactly one REST, GraphQL, SQL, or MongoDB oracle.",
    "SQL and MongoDB verification must be read-only. REST verifier paths must be relative to the target base URL.",
    "An empty allowed_surfaces list means unrestricted; do not use it to represent N/A.",
    "Return JSON only with a top-level tasks array.",
    `Canonical tasks:\n${JSON.stringify(suite.tasks.map(promptTask), null, 2)}`,
    `Documented capabilities:\n${JSON.stringify(capabilities.capabilities, null, 2)}`,
    `Documented surfaces:\n${JSON.stringify({ cli: surfaces.cli, sdk: surfaces.sdk, mcp: surfaces.mcp }, null, 2)}`,
  ].join("\n\n");
}

export async function extractTasks(
  vendor: ResolveResult,
  suite: Suite,
  capabilities: CapabilityExtractResult,
  surfaces: SurfaceExtractResult,
  options: { generate?: StructuredGenerator; extractor?: string; now?: () => Date } = {},
): Promise<TaskExtractResult> {
  if (!vendor.docs_url) throw new Error(`cannot extract tasks for ${vendor.vendor}: docs_url is missing`);
  if (
    capabilities.slug !== vendor.slug
    || capabilities.vendor !== vendor.vendor
    || surfaces.slug !== vendor.slug
    || surfaces.vendor !== vendor.vendor
  ) {
    throw new Error(`task extraction inputs do not belong to ${vendor.slug}`);
  }
  const parsed = GeneratedResultSchema.safeParse(parseStructuredOutput(
    await runStructuredGenerator(buildTaskExtractPrompt(vendor, suite, capabilities, surfaces), options.generate),
  ));
  if (!parsed.success) {
    throw new Error(`task extract for ${vendor.vendor} is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  validateTaskSet(parsed.data.tasks, suite, availableSurfaces(surfaces), [vendor.docs_url, vendor.site_url]);
  return TaskExtractSchema.parse({
    vendor: vendor.vendor,
    slug: vendor.slug,
    suite_name: suite.name,
    suite_version: suite.version,
    extracted_at: (options.now ?? (() => new Date()))().toISOString(),
    extractor: options.extractor ?? "host-default",
    tasks: suite.tasks.map((canonical) => ({
      ...parsed.data.tasks.find((task) => task.id === canonical.id)!,
      title: canonical.title,
      difficulty: canonical.difficulty,
    })),
  });
}

export function taskExtractPath(root: string, slug: string, suiteName: string): string {
  return resolve(
    root,
    "targets",
    "extracts",
    assertArtifactSegment(slug, "vendor slug"),
    `${assertArtifactSegment(suiteName, "suite name")}.tasks.yaml`,
  );
}

export function writeTaskExtract(root: string, result: TaskExtractResult): string {
  const path = taskExtractPath(root, result.slug, result.suite_name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, yamlStringify(TaskExtractSchema.parse(result)));
  renameSync(`${path}.tmp`, path);
  return path;
}

export function loadTaskExtract(root: string, slug: string, suiteName: string): TaskExtractResult | null {
  const path = taskExtractPath(root, slug, suiteName);
  if (!existsSync(path)) return null;
  const parsed = TaskExtractSchema.safeParse(yamlParse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`task extract at ${path} is malformed: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}
