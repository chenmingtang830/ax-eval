import type {
  HealthCheckContext,
  HealthCheckEvidence,
  HealthCheckProvider,
  TargetPack,
} from "ax-eval";

const PROVIDER_VERSION = "1.0.0";
const POSTGRES_PROVIDER_VERSION = "1.1.0";

function credential(
  context: Pick<HealthCheckContext, "credentials">,
  name: string,
): string | undefined {
  return context.credentials[name]?.trim() || undefined;
}

function resolveTemplate(value: string, context: HealthCheckContext): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    const found = credential(context, name);
    if (!found) throw new Error(`required health-check credential ${name} is missing`);
    return found;
  });
}

function inventoryEvidence(kind: string, count: number): HealthCheckEvidence[] {
  return [
    { status: "pass", message: `${kind} connection is reachable` },
    ...(count > 0
      ? [{ status: "warn" as const, message: `${count} leftover axarena resource(s) may cause namespace pollution` }]
      : []),
  ];
}

function nileSandboxBindingEvidence(
  context: HealthCheckContext,
  connectionString: string,
): HealthCheckEvidence[] | undefined {
  if (context.pack.name !== "nile") return undefined;
  const expectedDatabase = credential(context, "NILE_DB");
  let actualDatabase = "";
  try {
    actualDatabase = new URL(connectionString).pathname.replace(/^\//, "");
  } catch {
    return [{ status: "fail", message: "Nile database connection URL is invalid" }];
  }
  if (!expectedDatabase || actualDatabase !== expectedDatabase) {
    return [{
      status: "fail",
      message: "Nile sandbox binding requires NILE_DB to match the NILE_DATABASE_URL database",
    }];
  }
  return undefined;
}

export const postgresHealthCheckProvider: HealthCheckProvider = {
  id: "ax-arena-postgres-health",
  version: POSTGRES_PROVIDER_VERSION,
  matches: ({ pack }) => pack.sql_conn?.dialect === "postgres",
  async check(context) {
    const config = context.pack.sql_conn;
    if (!config || config.dialect !== "postgres") return [];
    const connectionString = credential(context, config.connection_string_env);
    if (!connectionString) {
      return [{ status: "fail", message: `Postgres credential ${config.connection_string_env} is missing` }];
    }
    const bindingFailure = nileSandboxBindingEvidence(context, connectionString);
    if (bindingFailure) return bindingFailure;
    const { Client } = await import("pg");
    const client = new Client({ connectionString });
    try {
      await client.connect();
      await client.query("SELECT 1");
      const tables = await client.query<{ count: string | number }>(
        "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'axarena\\_%' ESCAPE '\\'",
      );
      const functions = await client.query<{ count: string | number }>(
        "SELECT COUNT(*) AS count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'axarena\\_%' ESCAPE '\\'",
      );
      const roles = await client.query<{ count: string | number }>(
        "SELECT COUNT(*) AS count FROM pg_roles WHERE rolname LIKE 'axarena\\_%' ESCAPE '\\'",
      );
      const count = [tables, functions, roles]
        .map((result) => Number(result.rows[0]?.count ?? 0))
        .reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
      return inventoryEvidence("Postgres", Number.isFinite(count) ? count : 0);
    } catch {
      return [{ status: "fail", message: "Postgres health check failed" }];
    } finally {
      await client.end().catch(() => undefined);
    }
  },
};

export const mongoDbAtlasHealthCheckProvider: HealthCheckProvider = {
  id: "ax-arena-mongodb-atlas-health",
  version: PROVIDER_VERSION,
  matches: ({ pack }) => pack.name === "mongodb-atlas" || Boolean(pack.mongo_conn),
  async check(context) {
    const config = context.pack.mongo_conn;
    if (!config?.database) {
      return [{ status: "fail", message: "MongoDB health check requires a dedicated pack database" }];
    }
    const connectionString = credential(context, config.connection_string_env);
    if (!connectionString) {
      return [{ status: "fail", message: `MongoDB credential ${config.connection_string_env} is missing` }];
    }
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(connectionString);
    try {
      await client.connect();
      const db = client.db(config.database);
      await db.command({ ping: 1 });
      const collections = await db.listCollections().toArray();
      const count = collections.filter((entry: { name?: unknown }) =>
        typeof entry.name === "string" && entry.name.startsWith("axarena_")).length;
      return inventoryEvidence("MongoDB", count);
    } catch {
      return [{ status: "fail", message: "MongoDB health check failed" }];
    } finally {
      await client.close().catch(() => undefined);
    }
  },
};

function tursoRows(body: unknown): unknown[][] {
  const root = body as {
    results?: Array<{ response?: { result?: { rows?: Array<Array<{ value?: unknown }>> } } }>;
  };
  return root.results?.[0]?.response?.result?.rows?.map((row) => row.map((cell) => cell.value)) ?? [];
}

function authCredential(pack: TargetPack, context: HealthCheckContext): string | undefined {
  const names = [
    pack.auth?.verify_env,
    ...(pack.auth?.verify_env_aliases ?? []),
    pack.auth?.env,
    ...(pack.auth?.env_aliases ?? []),
  ].filter((name): name is string => Boolean(name));
  for (const name of names) {
    const value = credential(context, name);
    if (value) return value;
  }
  return undefined;
}

export const tursoHealthCheckProvider: HealthCheckProvider = {
  id: "ax-arena-turso-health",
  version: PROVIDER_VERSION,
  matches: ({ pack }) => pack.name === "turso",
  async check(context) {
    const token = authCredential(context.pack, context);
    if (!token) return [{ status: "fail", message: "Turso database auth credential is missing" }];
    try {
      const response = await fetch(`${resolveTemplate(context.pack.base_url, context).replace(/\/$/, "")}/v2/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            type: "execute",
            stmt: { sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'axarena_%'" },
          }],
        }),
        signal: context.signal,
      });
      if (!response.ok) return [{ status: "fail", message: `Turso health check returned HTTP ${response.status}` }];
      const count = tursoRows(await response.json())
        .filter((row) => typeof row[0] === "string" && row[0].startsWith("axarena_")).length;
      return inventoryEvidence("Turso", count);
    } catch {
      return [{ status: "fail", message: "Turso health check failed" }];
    }
  },
};

interface ConvexDeployment {
  name: string;
  deploymentType: "dev" | "prod" | "preview" | "custom";
  projectId: number;
  isDefault: boolean;
}

async function convexGet<T>(path: string, token: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`https://api.convex.dev/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as T;
}

export const convexHealthCheckProvider: HealthCheckProvider = {
  id: "ax-arena-convex-health",
  version: PROVIDER_VERSION,
  matches: ({ pack }) => pack.name === "convex",
  async check(context) {
    const token = credential(context, "CONVEX_TEAM_ACCESS_TOKEN")
      ?? credential(context, "CONVEX_MANAGEMENT_TOKEN");
    if (!token) {
      return [{ status: "warn", message: "Convex cleanup health check is unavailable without a team access token" }];
    }
    try {
      const host = new URL(resolveTemplate(context.pack.base_url, context)).hostname;
      const deploymentName = /^([a-z0-9-]+)\.convex\.cloud$/i.exec(host)?.[1];
      if (!deploymentName) return [{ status: "fail", message: "Convex pack base_url has no deployment name" }];
      const base = await convexGet<ConvexDeployment>(
        `/deployments/${encodeURIComponent(deploymentName)}`,
        token,
        context.signal,
      );
      const deployments = await convexGet<ConvexDeployment[]>(
        `/projects/${base.projectId}/list_deployments`,
        token,
        context.signal,
      );
      const count = deployments.filter((entry) => entry.deploymentType === "preview" && !entry.isDefault).length;
      return inventoryEvidence("Convex", count);
    } catch {
      return [{ status: "fail", message: "Convex management health check failed" }];
    }
  },
};

export const DATABASE_HEALTH_CHECK_PROVIDERS: readonly HealthCheckProvider[] = Object.freeze([
  postgresHealthCheckProvider,
  mongoDbAtlasHealthCheckProvider,
  tursoHealthCheckProvider,
  convexHealthCheckProvider,
]);
