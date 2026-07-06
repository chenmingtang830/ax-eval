/**
 * Generic sandbox teardown for pass@k hygiene.
 *
 * Repeated live runs leave probe resources behind (every generated resource is
 * named `AX probe <type> <ns>`), which contaminates later runs. `reset` lists
 * those candidate resources in the pack's declared sandbox scope and deletes
 * them. The framework is target-agnostic (resolve scope → list → match `{ns}`
 * naming convention → delete); reliable listing/deletion is target-specific, so
 * a per-target resetter is registered. Asana is the concrete reference; targets
 * without a resetter fail GRACEFULLY (a clear message, never a throw).
 */
import { PROBE_PREFIX } from "../generate/pack.js";
import type { TargetPack } from "../schemas.js";

/** The slice of the HTTP client a resetter needs (so tests stub it offline). */
export interface ResetClient {
  get<T = unknown>(path: string, query?: Record<string, string>): Promise<T>;
  del(path: string): Promise<void>;
}

export interface ResetOptions {
  /** Restrict deletion to names containing this namespace token; when unset,
   *  every probe-named resource in scope is a candidate. */
  ns?: string;
  /** List + match but don't delete (preview). */
  dryRun?: boolean;
}

export interface ResetResult {
  /** False when no resetter is registered for the target. */
  supported: boolean;
  message: string;
  /** Ids deleted (or that would be, under dryRun). */
  deleted: string[];
  /** Probe resources matched in scope. */
  candidates: number;
  errors: string[];
}

/** A probe resource is one whose name carries the AX prefix; when an ns is
 *  given it must also belong to that namespace. */
function isProbeName(name: unknown, ns?: string): boolean {
  if (typeof name !== "string" || !name.startsWith(PROBE_PREFIX)) return false;
  return ns ? name.includes(ns) : true;
}

function isAxArenaMongoName(name: unknown, ns?: string): boolean {
  if (typeof name !== "string" || !name.startsWith("axarena_")) return false;
  return ns ? name.includes(ns) : true;
}

/** Pick the scope value for a logical container, preferring a key that mentions
 *  the hint (e.g. "project"), else the first declared scope value. */
function containerId(scope: Record<string, string>, hint: string): string | undefined {
  const key = Object.keys(scope).find((k) => k.toLowerCase().includes(hint));
  return key ? scope[key] : Object.values(scope)[0];
}

interface ResetWork {
  deleted: string[];
  candidates: number;
  errors: string[];
}

type Resetter = (
  pack: TargetPack,
  client: ResetClient,
  scope: Record<string, string>,
  opts: ResetOptions,
) => Promise<ResetWork>;

/**
 * Asana reference: tasks are the sandbox-contained resource, listable under the
 * throwaway project the scope names. List them, keep AX-probe names, DELETE each.
 */
const asanaReset: Resetter = async (_pack, client, scope, opts) => {
  const project = containerId(scope, "project");
  if (!project) {
    return { deleted: [], candidates: 0, errors: ["no sandbox project id in scope — cannot list tasks to reset"] };
  }
  const tasks = await client.get<Array<{ gid?: string; name?: string }>>(`/projects/${project}/tasks`, {
    opt_fields: "name",
  });
  const candidates = (Array.isArray(tasks) ? tasks : []).filter((t) => t.gid && isProbeName(t.name, opts.ns));
  const deleted: string[] = [];
  const errors: string[] = [];
  for (const t of candidates) {
    if (opts.dryRun) {
      deleted.push(t.gid!);
      continue;
    }
    try {
      await client.del(`/tasks/${t.gid}`);
      deleted.push(t.gid!);
    } catch (err) {
      errors.push(`delete /tasks/${t.gid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { deleted, candidates: candidates.length, errors };
};

/**
 * MongoDB Atlas database reset: DAEB database tasks create collections and Atlas
 * Search/vector indexes under a dedicated verifier database (`axarena_eval`).
 * Agents must not delete unrelated resources during execution; this explicit
 * operator reset only targets eval-created `axarena_*` collections/indexes.
 */
const mongodbAtlasReset: Resetter = async (pack, _client, _scope, opts) => {
  if (!pack.mongo_conn) {
    return { deleted: [], candidates: 0, errors: ["pack declares no mongo_conn — cannot list MongoDB eval resources"] };
  }
  const connectionString = process.env[pack.mongo_conn.connection_string_env]?.trim();
  if (!connectionString) {
    return {
      deleted: [],
      candidates: 0,
      errors: [`mongo_conn env ${pack.mongo_conn.connection_string_env} is unset — cannot reset MongoDB eval resources`],
    };
  }
  const database = pack.mongo_conn.database;
  if (!database) {
    return { deleted: [], candidates: 0, errors: ["mongo_conn has no dedicated database — refusing broad MongoDB reset"] };
  }

  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(connectionString);
  const deleted: string[] = [];
  const errors: string[] = [];
  let candidates = 0;
  await client.connect();
  try {
    const db = client.db(database);
    const collections = (await db.listCollections().toArray())
      .map((c: { name?: unknown }) => c.name)
      .filter((name): name is string => isAxArenaMongoName(name, opts.ns));
    for (const collectionName of collections) {
      const collection = db.collection(collectionName);
      try {
        const indexes = await collection.listSearchIndexes().toArray();
        for (const index of indexes as Array<{ name?: unknown }>) {
          if (!isAxArenaMongoName(index.name, opts.ns)) continue;
          candidates += 1;
          const id = `${database}.${collectionName}/searchIndex/${index.name}`;
          if (opts.dryRun) {
            deleted.push(id);
            continue;
          }
          try {
            await collection.dropSearchIndex(String(index.name));
            deleted.push(id);
          } catch (err) {
            errors.push(`drop search index ${id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        errors.push(`list search indexes ${database}.${collectionName}: ${err instanceof Error ? err.message : String(err)}`);
      }

      candidates += 1;
      const id = `${database}.${collectionName}`;
      if (opts.dryRun) {
        deleted.push(id);
        continue;
      }
      try {
        await collection.drop();
        deleted.push(id);
      } catch (err) {
        errors.push(`drop collection ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await client.close();
  }
  return { deleted, candidates, errors };
};

/**
 * Generic Postgres-family reset for SQL-backed benchmark sandboxes. This only
 * targets eval-created `axarena_*` tables and routines inside the default
 * `public` schema, and uses CASCADE so dependent policies/indexes/triggers are
 * removed with the owning table/function. It intentionally does not attempt to
 * enumerate or delete control-plane artifacts such as backups, projects, or
 * roles outside the database connection declared by the pack.
 */
const postgresSqlReset: Resetter = async (pack, _client, _scope, opts) => {
  if (!pack.sql_conn || pack.sql_conn.dialect !== "postgres") {
    return { deleted: [], candidates: 0, errors: ["pack does not declare a postgres sql_conn — cannot reset SQL eval resources"] };
  }
  const connectionString = process.env[pack.sql_conn.connection_string_env]?.trim();
  if (!connectionString) {
    return {
      deleted: [],
      candidates: 0,
      errors: [`sql_conn env ${pack.sql_conn.connection_string_env} is unset — cannot reset SQL eval resources`],
    };
  }

  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  const deleted: string[] = [];
  const errors: string[] = [];
  let candidates = 0;
  await client.connect();
  try {
    const tableRows = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'axarena\\_%' ESCAPE '\\'",
    );
    const tables = tableRows.rows
      .map((row) => row.table_name)
      .filter((name) => isAxArenaMongoName(name, opts.ns));
    for (const table of tables) {
      candidates += 1;
      const id = `public.${table}`;
      if (opts.dryRun) {
        deleted.push(id);
        continue;
      }
      try {
        await client.query(`DROP TABLE IF EXISTS "public"."${table}" CASCADE`);
        deleted.push(id);
      } catch (err) {
        errors.push(`drop table ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const functionRows = await client.query<{ proname: string; identity_arguments: string }>(
      "SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS identity_arguments FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'axarena\\_%' ESCAPE '\\'",
    );
    const routines = functionRows.rows.filter((row) => isAxArenaMongoName(row.proname, opts.ns));
    for (const routine of routines) {
      candidates += 1;
      const signature = `${routine.proname}(${routine.identity_arguments})`;
      const id = `public.${signature}`;
      if (opts.dryRun) {
        deleted.push(id);
        continue;
      }
      try {
        await client.query(`DROP FUNCTION IF EXISTS "public"."${routine.proname}"(${routine.identity_arguments}) CASCADE`);
        deleted.push(id);
      } catch (err) {
        errors.push(`drop function ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await client.end();
  }
  return { deleted, candidates, errors };
};

/** Per-target resetters, keyed by pack name. */
const RESETTERS: Record<string, Resetter> = {
  asana: asanaReset,
  "asana-generated": asanaReset,
  "mongodb-atlas": mongodbAtlasReset,
};

/**
 * Resolve the target's resetter and run it. Returns `supported: false` (not a
 * throw) for targets whose listing/deletion isn't expressible yet, so callers
 * can degrade gracefully.
 */
export async function resetPack(
  pack: TargetPack,
  client: ResetClient,
  scope: Record<string, string>,
  opts: ResetOptions = {},
): Promise<ResetResult> {
  const resetter = RESETTERS[pack.name] ?? (pack.sql_conn?.dialect === "postgres" ? postgresSqlReset : undefined);
  if (!resetter) {
    return {
      supported: false,
      message:
        `No reset strategy for "${pack.name}" — sandbox listing/deletion isn't expressible yet for this target. ` +
        `Delete probe resources (named "${PROBE_PREFIX} …") manually.`,
      deleted: [],
      candidates: 0,
      errors: [],
    };
  }
  const { deleted, candidates, errors } = await resetter(pack, client, scope, opts);
  const verb = opts.dryRun ? "would delete" : "deleted";
  return {
    supported: true,
    message: `Reset ${pack.name}: ${verb} ${deleted.length}/${candidates} probe resource(s)${
      opts.ns ? ` in namespace "${opts.ns}"` : ""
    }.`,
    deleted,
    candidates,
    errors,
  };
}
