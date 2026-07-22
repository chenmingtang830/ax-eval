import type {
  ResetContext,
  ResetEvidence,
  ResetPlan,
  ResetProvider,
  TargetDescriptor,
  TargetPack,
} from "ax-eval";

const PROVIDER_VERSION = "1.0.0";
const MAX_RESOURCES = 100;

function validNamespace(namespace: string): string {
  const value = namespace.trim();
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("cleanup namespace may contain only letters, numbers, dot, underscore, and hyphen");
  }
  return value;
}

function credential(context: Pick<ResetContext, "credentials">, name: string): string {
  const value = context.credentials[name]?.trim();
  if (!value) throw new Error(`required cleanup credential ${name} is missing`);
  return value;
}

function resolveTemplate(value: string, credentials: Readonly<Record<string, string>>): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => credential({ credentials }, name));
}

function isArenaName(name: unknown, namespace: string): name is string {
  return typeof name === "string"
    && name.startsWith("axarena_")
    && name.endsWith(`_${namespace}`);
}

function endsWithNamespace(value: string, namespace: string): boolean {
  return value === namespace || value.endsWith(`-${namespace}`) || value.endsWith(`_${namespace}`);
}

function convexDeploymentMatchesNamespace(
  deployment: ConvexDeployment,
  patterns: readonly string[],
): boolean {
  return [deployment.previewIdentifier, deployment.reference, deployment.name]
    .filter((value): value is string => typeof value === "string")
    .some((value) => patterns.some((pattern) => endsWithNamespace(value, pattern)));
}

function boundedPlan(summary: string, resources: readonly string[]): ResetPlan {
  if (resources.length > MAX_RESOURCES) {
    throw new Error(`refusing cleanup: ${resources.length} resources exceeds the safety limit of ${MAX_RESOURCES}`);
  }
  return { summary, resources };
}

function validateExecutablePlan(plan: ResetPlan): void {
  if (plan.resources.length > MAX_RESOURCES) {
    throw new Error(`refusing cleanup: ${plan.resources.length} resources exceeds the safety limit of ${MAX_RESOURCES}`);
  }
}

function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function postgresTableResource(name: string): string {
  return `postgres:table:${encodeURIComponent(name)}`;
}

function postgresFunctionResource(name: string, args: string): string {
  return `postgres:function:${encodeURIComponent(name)}:${encodeURIComponent(args)}`;
}

function parsePostgresResource(resource: string):
  | { kind: "table"; name: string }
  | { kind: "function"; name: string; args: string } {
  const [scheme, kind, encodedName, encodedArgs, ...extra] = resource.split(":");
  if (scheme !== "postgres" || extra.length || !encodedName) throw new Error("invalid Postgres cleanup resource");
  if (kind === "table" && encodedArgs === undefined) {
    return { kind, name: decodeURIComponent(encodedName) };
  }
  if (kind === "function" && encodedArgs !== undefined) {
    return { kind, name: decodeURIComponent(encodedName), args: decodeURIComponent(encodedArgs) };
  }
  throw new Error("invalid Postgres cleanup resource");
}

function postgresMatches({ pack }: TargetDescriptor): boolean {
  return pack.sql_conn?.dialect === "postgres";
}

export const postgresResetProvider: ResetProvider = {
  id: "ax-arena-postgres-reset",
  version: PROVIDER_VERSION,
  matches: postgresMatches,
  async plan(context) {
    const namespace = validNamespace(context.namespace);
    const sql = context.pack.sql_conn;
    if (!sql || sql.dialect !== "postgres") throw new Error("pack does not declare a Postgres connection");
    const { Client } = await import("pg");
    const client = new Client({ connectionString: credential(context, sql.connection_string_env) });
    await client.connect();
    try {
      const tableRows = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'axarena\\_%' ESCAPE '\\'",
      );
      const functionRows = await client.query<{ proname: string; identity_arguments: string }>(
        "SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS identity_arguments FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'axarena\\_%' ESCAPE '\\'",
      );
      const resources = [
        ...tableRows.rows
          .map((row) => row.table_name)
          .filter((name) => isArenaName(name, namespace))
          .map(postgresTableResource),
        ...functionRows.rows
          .filter((row) => isArenaName(row.proname, namespace))
          .map((row) => postgresFunctionResource(row.proname, row.identity_arguments)),
      ];
      return boundedPlan(`Delete ${resources.length} namespaced Postgres resource(s)`, resources);
    } finally {
      await client.end();
    }
  },
  async execute(plan, context) {
    validateExecutablePlan(plan);
    const namespace = validNamespace(context.namespace);
    const sql = context.pack.sql_conn;
    if (!sql || sql.dialect !== "postgres") {
      return { supported: false, message: "pack does not declare a Postgres connection", deleted: [], errors: [] };
    }
    const parsed = plan.resources.map(parsePostgresResource);
    if (parsed.some((resource) => !isArenaName(resource.name, namespace))) {
      throw new Error("Postgres cleanup plan contains a resource outside the cell namespace");
    }
    if (context.dryRun) {
      return { supported: true, message: `Would delete ${parsed.length} Postgres resource(s)`, deleted: plan.resources, errors: [] };
    }
    const { Client } = await import("pg");
    const client = new Client({ connectionString: credential(context, sql.connection_string_env) });
    const deleted: string[] = [];
    const errors: string[] = [];
    await client.connect();
    try {
      for (const [index, resource] of parsed.entries()) {
        const id = plan.resources[index]!;
        const statement = resource.kind === "table"
          ? `DROP TABLE IF EXISTS "public".${quotePostgresIdentifier(resource.name)} CASCADE`
          : `DROP FUNCTION IF EXISTS "public".${quotePostgresIdentifier(resource.name)}(${resource.args}) CASCADE`;
        try {
          await client.query(statement);
          deleted.push(id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/drop(?: function)? cascade is not supported|drop function.*cascade.*not supported/i.test(message)) {
            try {
              await client.query(statement.replace(/ CASCADE$/, ""));
              deleted.push(id);
              continue;
            } catch {
              errors.push(`failed to delete ${id} without CASCADE`);
              continue;
            }
          }
          errors.push(`failed to delete ${id}`);
        }
      }
    } finally {
      await client.end();
    }
    return { supported: true, message: `Deleted ${deleted.length}/${parsed.length} Postgres resource(s)`, deleted, errors };
  },
};

function mongoResource(kind: "collection" | "search-index", database: string, collection: string, index = ""): string {
  return `mongodb:${kind}:${encodeURIComponent(database)}:${encodeURIComponent(collection)}:${encodeURIComponent(index)}`;
}

function parseMongoResource(resource: string): {
  kind: "collection" | "search-index";
  database: string;
  collection: string;
  index: string;
} {
  const [scheme, kind, database, collection, index, ...extra] = resource.split(":");
  if (scheme !== "mongodb" || (kind !== "collection" && kind !== "search-index")
    || !database || !collection || index === undefined || extra.length) {
    throw new Error("invalid MongoDB cleanup resource");
  }
  return {
    kind,
    database: decodeURIComponent(database),
    collection: decodeURIComponent(collection),
    index: decodeURIComponent(index),
  };
}

export const mongoDbAtlasResetProvider: ResetProvider = {
  id: "ax-arena-mongodb-atlas-reset",
  version: PROVIDER_VERSION,
  matches: ({ pack }) => pack.name === "mongodb-atlas" || Boolean(pack.mongo_conn),
  async plan(context) {
    const namespace = validNamespace(context.namespace);
    const config = context.pack.mongo_conn;
    if (!config?.database) throw new Error("MongoDB cleanup requires a dedicated pack database");
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(credential(context, config.connection_string_env));
    await client.connect();
    try {
      const db = client.db(config.database);
      const collections = (await db.listCollections().toArray())
        .map((entry: { name?: unknown }) => entry.name)
        .filter((name) => isArenaName(name, namespace));
      const resources: string[] = [];
      for (const collectionName of collections) {
        try {
          const indexes = await db.collection(collectionName).listSearchIndexes().toArray();
          for (const index of indexes as Array<{ name?: unknown }>) {
            if (isArenaName(index.name, namespace)) {
              resources.push(mongoResource("search-index", config.database, collectionName, index.name));
            }
          }
        } catch {
          // Collection deletion still removes its indexes. Some Atlas tiers do
          // not expose Search index listing to the database credential.
        }
        resources.push(mongoResource("collection", config.database, collectionName));
      }
      return boundedPlan(`Delete ${resources.length} namespaced MongoDB resource(s)`, resources);
    } finally {
      await client.close();
    }
  },
  async execute(plan, context) {
    validateExecutablePlan(plan);
    const namespace = validNamespace(context.namespace);
    const config = context.pack.mongo_conn;
    if (!config?.database) {
      return { supported: false, message: "MongoDB cleanup requires a dedicated pack database", deleted: [], errors: [] };
    }
    const parsed = plan.resources.map(parseMongoResource);
    if (parsed.some((resource) => resource.database !== config.database
      || !isArenaName(resource.collection, namespace)
      || (resource.kind === "search-index" && !isArenaName(resource.index, namespace)))) {
      throw new Error("MongoDB cleanup plan contains a resource outside the dedicated database or cell namespace");
    }
    if (context.dryRun) {
      return { supported: true, message: `Would delete ${parsed.length} MongoDB resource(s)`, deleted: plan.resources, errors: [] };
    }
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(credential(context, config.connection_string_env));
    const deleted: string[] = [];
    const errors: string[] = [];
    await client.connect();
    try {
      const db = client.db(config.database);
      for (const [index, resource] of parsed.entries()) {
        const id = plan.resources[index]!;
        try {
          const collection = db.collection(resource.collection);
          if (resource.kind === "search-index") await collection.dropSearchIndex(resource.index);
          else await collection.drop();
          deleted.push(id);
        } catch {
          errors.push(`failed to delete ${id}`);
        }
      }
    } finally {
      await client.close();
    }
    return { supported: true, message: `Deleted ${deleted.length}/${parsed.length} MongoDB resource(s)`, deleted, errors };
  },
};

function tursoPipelineBody(sql: string): object {
  return { requests: [{ type: "execute", stmt: { sql } }] };
}

function tursoRows(body: unknown): unknown[][] {
  const root = body as {
    results?: Array<{ response?: { result?: { rows?: Array<Array<{ value?: unknown }>> } } }>;
  };
  return root.results?.[0]?.response?.result?.rows?.map((row) => row.map((cell) => cell.value)) ?? [];
}

function tursoEndpoint(pack: TargetPack, credentials: Readonly<Record<string, string>>): string {
  return `${resolveTemplate(pack.base_url, credentials).replace(/\/$/, "")}/v2/pipeline`;
}

function tursoToken(context: ResetContext): string {
  const name = context.pack.auth?.env;
  if (!name) throw new Error("Turso pack does not declare an auth credential");
  return credential(context, name);
}

export const tursoResetProvider: ResetProvider = {
  id: "ax-arena-turso-reset",
  version: PROVIDER_VERSION,
  matches: ({ pack }) => pack.name === "turso",
  async plan(context) {
    const namespace = validNamespace(context.namespace);
    const response = await fetch(tursoEndpoint(context.pack, context.credentials), {
      method: "POST",
      headers: { Authorization: `Bearer ${tursoToken(context)}`, "Content-Type": "application/json" },
      body: JSON.stringify(tursoPipelineBody("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'axarena_%'")),
      signal: context.signal,
    });
    if (!response.ok) throw new Error(`Turso cleanup inventory returned HTTP ${response.status}`);
    const resources = tursoRows(await response.json())
      .map((row) => row[0])
      .filter((name) => isArenaName(name, namespace))
      .map((name) => `turso:table:${encodeURIComponent(name)}`);
    return boundedPlan(`Delete ${resources.length} namespaced Turso table(s)`, resources);
  },
  async execute(plan, context) {
    validateExecutablePlan(plan);
    const namespace = validNamespace(context.namespace);
    const names = plan.resources.map((resource) => {
      const [scheme, kind, encodedName, ...extra] = resource.split(":");
      if (scheme !== "turso" || kind !== "table" || !encodedName || extra.length) {
        throw new Error("invalid Turso cleanup resource");
      }
      const name = decodeURIComponent(encodedName);
      if (!isArenaName(name, namespace) || !/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new Error("Turso cleanup plan contains a resource outside the cell namespace");
      }
      return name;
    });
    if (context.dryRun) {
      return { supported: true, message: `Would delete ${names.length} Turso table(s)`, deleted: plan.resources, errors: [] };
    }
    const deleted: string[] = [];
    const errors: string[] = [];
    for (const [index, name] of names.entries()) {
      const response = await fetch(tursoEndpoint(context.pack, context.credentials), {
        method: "POST",
        headers: { Authorization: `Bearer ${tursoToken(context)}`, "Content-Type": "application/json" },
        body: JSON.stringify(tursoPipelineBody(`DROP TABLE IF EXISTS "${name}"`)),
        signal: context.signal,
      });
      if (response.ok) deleted.push(plan.resources[index]!);
      else errors.push(`failed to delete ${plan.resources[index]} (HTTP ${response.status})`);
    }
    return { supported: true, message: `Deleted ${deleted.length}/${names.length} Turso table(s)`, deleted, errors };
  },
};

interface ConvexDeployment {
  id: number;
  name: string;
  deploymentType: "dev" | "prod" | "preview" | "custom";
  projectId: number;
  isDefault: boolean;
  previewIdentifier?: string | null;
  reference?: string;
}

function convexManagementToken(context: ResetContext): string {
  const name = context.credentials.CONVEX_TEAM_ACCESS_TOKEN
    ? "CONVEX_TEAM_ACCESS_TOKEN"
    : "CONVEX_MANAGEMENT_TOKEN";
  return credential(context, name);
}

function convexDeploymentName(pack: TargetPack, credentials: Readonly<Record<string, string>>): string {
  const baseUrl = resolveTemplate(pack.base_url, credentials);
  const match = /^([a-z0-9-]+)\.convex\.cloud$/i.exec(new URL(baseUrl).hostname);
  if (!match?.[1]) throw new Error("could not parse Convex deployment name from pack base_url");
  return match[1];
}

async function convexRequest<T>(
  path: string,
  context: ResetContext,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://api.convex.dev/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${convexManagementToken(context)}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`Convex management request returned HTTP ${response.status}`);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export const convexResetProvider: ResetProvider = {
  id: "ax-arena-convex-reset",
  version: PROVIDER_VERSION,
  matches: ({ pack }) => pack.name === "convex",
  async plan(context) {
    const namespace = validNamespace(context.namespace);
    const base = await convexRequest<ConvexDeployment>(
      `/deployments/${encodeURIComponent(convexDeploymentName(context.pack, context.credentials))}`,
      context,
    );
    const deployments = await convexRequest<ConvexDeployment[]>(
      `/projects/${base.projectId}/list_deployments`,
      context,
    );
    const patterns = [namespace, namespace.replaceAll("-", "_"), namespace.replaceAll("_", "-")];
    const resources = deployments
      .filter((deployment) => deployment.deploymentType === "preview" && !deployment.isDefault)
      .filter((deployment) => convexDeploymentMatchesNamespace(deployment, patterns))
      .map((deployment) => `convex:preview:${encodeURIComponent(deployment.name)}`);
    return boundedPlan(`Delete ${resources.length} namespaced Convex preview deployment(s)`, resources);
  },
  async execute(plan, context) {
    validateExecutablePlan(plan);
    const namespace = validNamespace(context.namespace);
    const patterns = [namespace, namespace.replaceAll("-", "_"), namespace.replaceAll("_", "-")];
    const names = plan.resources.map((resource) => {
      const [scheme, kind, encodedName, ...extra] = resource.split(":");
      if (scheme !== "convex" || kind !== "preview" || !encodedName || extra.length) {
        throw new Error("invalid Convex cleanup resource");
      }
      const name = decodeURIComponent(encodedName);
      return name;
    });
    const base = await convexRequest<ConvexDeployment>(
      `/deployments/${encodeURIComponent(convexDeploymentName(context.pack, context.credentials))}`,
      context,
    );
    const deployments = await convexRequest<ConvexDeployment[]>(
      `/projects/${base.projectId}/list_deployments`,
      context,
    );
    const allowed = new Set(deployments
      .filter((deployment) => deployment.deploymentType === "preview" && !deployment.isDefault)
      .filter((deployment) => convexDeploymentMatchesNamespace(deployment, patterns))
      .map((deployment) => deployment.name));
    if (names.some((name) => !allowed.has(name))) {
      throw new Error("Convex cleanup plan contains a deployment outside the cell namespace");
    }
    if (context.dryRun) {
      return { supported: true, message: `Would delete ${names.length} Convex preview deployment(s)`, deleted: plan.resources, errors: [] };
    }
    const deleted: string[] = [];
    const errors: string[] = [];
    for (const [index, name] of names.entries()) {
      try {
        await convexRequest(`/deployments/${encodeURIComponent(name)}/delete`, context, {
          method: "POST",
          body: "{}",
        });
        deleted.push(plan.resources[index]!);
      } catch {
        errors.push(`failed to delete ${plan.resources[index]}`);
      }
    }
    return { supported: true, message: `Deleted ${deleted.length}/${names.length} Convex preview deployment(s)`, deleted, errors };
  },
};

export const DATABASE_RESET_PROVIDERS: readonly ResetProvider[] = Object.freeze([
  postgresResetProvider,
  mongoDbAtlasResetProvider,
  tursoResetProvider,
  convexResetProvider,
]);

export type DatabaseResetEvidence = ResetEvidence;
