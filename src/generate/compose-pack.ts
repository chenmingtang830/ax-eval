import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  SurfaceAuthSchema,
  TargetPackSchema,
  type OracleSpec,
  type SurfaceAuth,
  type TargetPack,
} from "../schemas.js";
import { packToYaml } from "./pack.js";
import { assertArtifactSegment } from "./artifact-path.js";
import { parsePackComposeConfig, type PackComposeConfig } from "./pack-compose-config.js";
import { urlUsesOfficialHost } from "./public-url.js";
import { SuiteSchema, validatePackAgainstSuite, type Suite } from "./suite.js";
import { SurfaceExtractSchema, type SurfaceExtractResult } from "./surface-extract.js";
import { TaskExtractSchema, type TaskExtractResult } from "./task-extract.js";
import { ResolveResultSchema, type ResolveResult } from "./vendor-resolve.js";

function normalizeSurfaceAuth(extracted: { kind: "inherit" | "token" | "oauth_app"; token_env?: string | null }): SurfaceAuth {
  return SurfaceAuthSchema.parse({ kind: extracted.kind, token_env: extracted.token_env ?? undefined });
}

function usedSurfaces(tasks: TaskExtractResult["tasks"], surfaces: SurfaceExtractResult): Set<string> {
  const available = ["api", surfaces.cli && "cli", surfaces.sdk && "sdk", surfaces.mcp && "mcp"]
    .filter((surface): surface is string => Boolean(surface));
  const supported = tasks.filter((task) => !task.na);
  if (supported.some((task) => task.allowed_surfaces.length === 0)) return new Set(available);
  return new Set(supported.flatMap((task) => task.allowed_surfaces));
}

function validateVerificationConfig(tasks: TaskExtractResult["tasks"], config: PackComposeConfig): void {
  const oracles = tasks.flatMap((task) => task.oracles) as OracleSpec[];
  const sqlOracles = oracles.filter((oracle) => oracle.sqlQuery);
  if (sqlOracles.length > 0 && !config.sql_conn) {
    throw new Error("pack composition requires sql_conn for SQL verifier oracles");
  }
  for (const oracle of sqlOracles) {
    if (oracle.sqlDialect !== config.sql_conn?.dialect) {
      throw new Error(`SQL verifier dialect ${oracle.sqlDialect} does not match pack sql_conn ${config.sql_conn?.dialect}`);
    }
  }
  if (oracles.some((oracle) => oracle.mongoQuery) && !config.mongo_conn) {
    throw new Error("pack composition requires mongo_conn for MongoDB verifier oracles");
  }
  const hasRest = oracles.some((oracle) => oracle.readPathTemplate);
  const hasGraphql = oracles.some((oracle) => oracle.readQueryTemplate);
  if ((hasRest || hasGraphql) && !config.base_url) {
    throw new Error("pack composition requires base_url for HTTP verifier oracles");
  }
  if (hasGraphql && config.api_style !== "graphql") {
    throw new Error("GraphQL verifier oracles require api_style=graphql");
  }
  if (hasRest && config.api_style !== "rest") {
    throw new Error("REST verifier oracles require api_style=rest");
  }
  if (hasRest && hasGraphql) throw new Error("one pack cannot mix REST and GraphQL verifier styles");
}

function composeSurfaces(
  extracted: SurfaceExtractResult,
  config: PackComposeConfig,
  used: Set<string>,
): TargetPack["surfaces"] {
  const cli = extracted.cli && used.has("cli") ? {
    bin: extracted.cli.bin,
    install: extracted.cli.install,
    docs_url: extracted.cli.docs_url,
    auth: config.surface_auth?.cli ?? normalizeSurfaceAuth(extracted.cli.auth),
  } : undefined;
  const sdk = extracted.sdk && used.has("sdk") ? {
    package: extracted.sdk.package,
    language: extracted.sdk.language,
    install: extracted.sdk.install,
    reference_url: extracted.sdk.reference_url,
    auth: config.surface_auth?.sdk ?? normalizeSurfaceAuth(extracted.sdk.auth),
  } : undefined;
  const mcp = extracted.mcp && used.has("mcp") ? {
    server: extracted.mcp.server,
    transport: extracted.mcp.transport,
    args: extracted.mcp.args,
    docs_url: extracted.mcp.docs_url,
    auth: config.surface_auth?.mcp ?? normalizeSurfaceAuth(extracted.mcp.auth),
  } : undefined;
  return cli || sdk || mcp ? { cli, sdk, mcp } : undefined;
}

export function composePack(
  vendor: ResolveResult,
  suite: Suite,
  surfaces: SurfaceExtractResult,
  taskExtract: TaskExtractResult,
  rawConfig: PackComposeConfig,
  options: { now?: () => Date; generatedBy?: string } = {},
): TargetPack {
  ResolveResultSchema.parse(vendor);
  SuiteSchema.parse(suite);
  SurfaceExtractSchema.parse(surfaces);
  TaskExtractSchema.parse(taskExtract);
  if (
    surfaces.slug !== vendor.slug
    || surfaces.vendor !== vendor.vendor
    || taskExtract.slug !== vendor.slug
    || taskExtract.vendor !== vendor.vendor
  ) {
    throw new Error(`pack composition inputs do not belong to ${vendor.slug}`);
  }
  if (taskExtract.suite_name !== suite.name || taskExtract.suite_version !== suite.version) {
    throw new Error(`task extract does not match suite ${suite.name} v${suite.version}`);
  }
  const config = parsePackComposeConfig(rawConfig);
  validateVerificationConfig(taskExtract.tasks, config);
  const availableSurfaces = new Set([
    "api",
    ...(surfaces.cli ? ["cli"] : []),
    ...(surfaces.sdk ? ["sdk"] : []),
    ...(surfaces.mcp ? ["mcp"] : []),
  ]);
  for (const task of taskExtract.tasks) {
    for (const surface of task.allowed_surfaces) {
      if (!availableSurfaces.has(surface)) throw new Error(`task ${task.id} uses unavailable surface ${surface}`);
    }
    for (const evidence of task.support_evidence) {
      if (!urlUsesOfficialHost(evidence.doc_url, [vendor.docs_url, vendor.site_url])) {
        throw new Error(`task ${task.id} cites non-official host ${evidence.doc_url}`);
      }
    }
  }
  const used = usedSurfaces(taskExtract.tasks, surfaces);
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const pack = TargetPackSchema.parse({
    name: vendor.slug,
    version: "1",
    standard_set_version: `${suite.name}-v${suite.version}`,
    run_id: generatedAt.replace(/[-:TZ.]/g, "").slice(0, 14),
    generated_by: options.generatedBy ?? "suite-compose@review-required",
    generator: {
      harness: taskExtract.extractor,
      model: "host-default",
      effort: "high",
      prompt_version: "suite-compose-v1",
      source_docs: [vendor.docs_url].filter((url): url is string => Boolean(url)),
    },
    api_style: config.api_style,
    auth_method: config.auth.type,
    auth: config.auth,
    sandbox_scope: config.sandbox_scope,
    sql_conn: config.sql_conn,
    mongo_conn: config.mongo_conn,
    surfaces: composeSurfaces(surfaces, config, used),
    base_url: config.base_url,
    request_envelope: config.request_envelope,
    response_envelope: config.response_envelope,
    headers: config.headers,
    field_select_param: config.field_select_param,
    site_url: vendor.site_url ?? "",
    docs_urls: vendor.docs_url ? [vendor.docs_url] : [],
    discovery: config.discovery,
    static: vendor.site_url ? {
      site_url: vendor.site_url,
      docs_urls: vendor.docs_url ? [vendor.docs_url] : [],
      checks: [],
    } : undefined,
    tasks: taskExtract.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      difficulty: task.difficulty,
      allowed_surfaces: task.allowed_surfaces,
      na: task.na || undefined,
      na_reason: task.na_reason ?? undefined,
      support_evidence: task.support_evidence,
      oracles: task.oracles,
    })),
  });
  const suiteErrors = validatePackAgainstSuite(pack.tasks, suite);
  if (suiteErrors.length > 0) throw new Error(`composed pack diverges from canonical suite: ${suiteErrors.join("; ")}`);
  return pack;
}

export function composedPackPath(root: string, slug: string, suiteName: string): string {
  return resolve(
    root,
    "targets",
    "packs",
    assertArtifactSegment(slug, "vendor slug"),
    `${assertArtifactSegment(suiteName, "suite name")}.yaml`,
  );
}

export function writeComposedPack(root: string, pack: TargetPack, suiteName: string): string {
  const path = composedPackPath(root, pack.name, suiteName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, packToYaml(TargetPackSchema.parse(pack)));
  renameSync(`${path}.tmp`, path);
  return path;
}
