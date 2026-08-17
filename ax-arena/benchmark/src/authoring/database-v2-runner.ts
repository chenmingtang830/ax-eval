import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { loadDotenv } from "ax-eval";
import {
  buildV2SupportMatrix,
  validateV2WitnessPlan,
  type V2SupportMatrix,
  type V2WitnessPlan,
  type V2WitnessProof,
} from "./database-v2-witness.js";

export interface V2WitnessRunOptions {
  benchmarkRoot: string;
  runRoot: string;
  vendors?: readonly string[];
  tasks?: readonly string[];
  apply: boolean;
  /** Production witnesses must prove they are not targeting a local Cockroach process. */
  production?: boolean;
}

export interface V2WitnessCellResult {
  vendor: string;
  task_id: string;
  status: "passed" | "failed" | "blocked";
  reason: string;
  artifact_dir: string;
  proof?: V2WitnessProof;
}

export interface V2WitnessRunManifest {
  schema: "ax.daeb-v2-witness-run/v1";
  benchmark: "DAEB-2";
  generated_at: string;
  mode: "cli-only";
  run_root: string;
  apply: boolean;
  cells: V2WitnessCellResult[];
}

export interface V2SqlResult {
  status: number | null;
  stdout: string;
  stderr: string;
  command: string;
}

export interface V2Driver {
  vendor: string;
  commandLabel: string;
  requiredEnv: string[];
  missingEnv: string[];
  run(sql: string): V2SqlResult;
}

export interface V2StageRecord {
  status: "passed" | "failed";
  command: string;
  sql: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  observed?: string;
  error?: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function redact(value: string): string {
  let output = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (!secret || secret.length < 8) continue;
    if (/TOKEN|KEY|PASSWORD|SECRET|URL|CONNECTION|API/i.test(key)) output = output.split(secret).join(`<redacted:${key}>`);
  }
  return output
    .replace(/postgres(?:ql)?:\/\/[^\s'"\)]+/gi, "<connection-redacted>")
    .replace(/https?:\/\/[^\s'"\)]+(?:token|key|secret|password)[^\s'"\)]*/gi, "<credential-url-redacted>");
}

function scalar(result: V2SqlResult): string {
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1)?.replace(/^['"]|['"]$/g, "") ?? "";
}

/**
 * A local `cockroach start-single-node` can make a superficially successful
 * witness meaningless. Production witnesses must use the declared hosted SQL
 * endpoint and TLS; this check happens before any cell writes are attempted.
 */
export function cockroachProductionTargetIssue(connection: string | undefined): string | undefined {
  if (!connection) return "missing required CLI credential/context: COCKROACH_CONNECTION_STRING";
  let url: URL;
  try {
    url = new URL(connection);
  } catch {
    return "COCKROACH_CONNECTION_STRING must be a valid postgres connection URL for production";
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    return "COCKROACH_CONNECTION_STRING must use the postgres SQL-wire protocol for production";
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const localIpv4 = /^127(?:\.\d{1,3}){3}$/.test(host) || host === "0.0.0.0";
  const localIpv6 = host === "::1" || host === "::" || host === "::ffff:127.0.0.1";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || localIpv4 || localIpv6 || (isIP(host) !== 0 && (host.startsWith("127.") || host === "0.0.0.0"))) {
    return "production Cockroach target must not resolve to localhost, loopback, or a .local endpoint";
  }
  if (url.searchParams.get("sslmode") === "disable") {
    return "production Cockroach target must use TLS; sslmode=disable is not allowed";
  }
  return undefined;
}

export function makeV2Driver(vendor: string): V2Driver {
  const requiredEnv = vendor === "cockroachdb"
    ? ["COCKROACH_CONNECTION_STRING"]
    : vendor === "insforge"
      ? ["INSFORGE_CONNECTION_STRING"]
      : vendor === "neon"
        ? ["NEON_DATABASE_URL"]
      : vendor === "nile"
        ? ["NILE_DATABASE_URL"]
        : vendor === "supabase"
          ? ["SUPABASE_DB_URL"]
          : ["TURSO_SANDBOX_DATABASE"];
  const missingEnv = requiredEnv.filter((key) => !process.env[key]);
  if (missingEnv.length) {
    return {
      vendor,
      commandLabel: "unavailable",
      requiredEnv,
      missingEnv,
      run: () => ({ status: null, stdout: "", stderr: `missing required env: ${missingEnv.join(", ")}`, command: "blocked" }),
    };
  }
  if (vendor === "cockroachdb") {
    const connection = process.env.COCKROACH_CONNECTION_STRING!;
    return {
      vendor,
      commandLabel: "cockroach sql --url <COCKROACH_CONNECTION_STRING>",
      requiredEnv,
      missingEnv,
      run: (sql) => {
        const result = spawnSync("cockroach", ["sql", "--url", connection, "--format=tsv", "--execute", sql], {
          encoding: "utf8",
          timeout: 120_000,
          env: process.env,
        });
        return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", command: "cockroach sql --url <COCKROACH_CONNECTION_STRING> --format=tsv --execute <sql>" };
      },
    };
  }
  if (vendor === "turso") {
    const database = process.env.TURSO_SANDBOX_DATABASE!;
    return {
      vendor,
      commandLabel: "turso db shell <TURSO_SANDBOX_DATABASE> <sql>",
      requiredEnv,
      missingEnv,
      run: (sql) => {
        const result = spawnSync("turso", ["db", "shell", database, sql], {
          encoding: "utf8",
          timeout: 120_000,
          env: process.env,
        });
        return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", command: "turso db shell <TURSO_SANDBOX_DATABASE> <sql>" };
      },
    };
  }
  const envKey = vendor === "neon"
    ? "NEON_DATABASE_URL"
    : vendor === "nile"
      ? "NILE_DATABASE_URL"
      : vendor === "supabase"
        ? "SUPABASE_DB_URL"
        : "INSFORGE_CONNECTION_STRING";
  const connection = process.env[envKey]!;
  return {
    vendor,
    commandLabel: `psql <${envKey}> -X -v ON_ERROR_STOP=1`,
    requiredEnv,
    missingEnv,
    run: (sql) => {
      const result = spawnSync("psql", [connection, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-F", "\t", "-c", sql], {
        encoding: "utf8",
        timeout: 120_000,
        env: process.env,
      });
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", command: `psql <${envKey}> -X -v ON_ERROR_STOP=1 -At -c <sql>` };
    },
  };
}

function table(ns: string, suffix: string): string {
  return `"axarena_${suffix}_${ns}"`;
}

function role(ns: string): string {
  return `"axarena_acl_denied_${ns}"`;
}

function sqlPlan(vendor: string, taskId: string, ns: string): { setup: string; mutation: string; verify: string; cleanup: string; expected?: string } {
  const migrate = table(ns, "migrate");
  const schema = table(ns, "schema_probe");
  const query = table(ns, "query_items");
  const vectors = table(ns, "vectors");
  const writes = table(ns, "write_items");
  const search = table(ns, "search");
  const session = table(ns, "session_probe");
  const principal = table(ns, "principal_probe");
  const constraints = table(ns, "constraint_probe");
  const transactions = table(ns, "txn_probe");
  const aggregates = table(ns, "aggregate_probe");
  const negative = table(ns, "negative_query_probe");
  const vectorType = vendor === "cockroachdb" ? "VECTOR(3)" : vendor === "turso" ? "BLOB" : "vector(3)";
  if (taskId === "db-T17-cli-session-discovery") {
    return {
      setup: `CREATE TABLE ${session} (marker TEXT, principal TEXT);`,
      mutation: `INSERT INTO ${session} (marker,principal) SELECT 'session_${ns}', current_user;`,
      verify: `SELECT (SELECT COUNT(*) FROM ${session} WHERE marker='session_${ns}') || '|' || (SELECT COUNT(*) FROM ${session} WHERE marker='session_${ns}' AND principal <> '');`,
      cleanup: `DROP TABLE IF EXISTS ${session};`,
      expected: "1|1",
    };
  }
  if (taskId === "db-T21-cli-principal-continuity") {
    return {
      setup: `CREATE TABLE ${principal} (marker TEXT, principal TEXT);`,
      mutation: `INSERT INTO ${principal} (marker,principal) SELECT 'principal_${ns}', current_user;`,
      verify: `SELECT (SELECT COUNT(*) FROM ${principal} WHERE marker='principal_${ns}') || '|' || (SELECT COUNT(*) FROM ${principal} WHERE marker='principal_${ns}' AND principal <> '');`,
      cleanup: `DROP TABLE IF EXISTS ${principal};`,
      expected: "1|1",
    };
  }
  if (taskId === "db-T18-constraint-preservation") {
    const mutation = vendor === "turso"
      ? `INSERT INTO ${constraints} (record_id,marker) VALUES ('row_${ns}','constraint_${ns}'); INSERT OR IGNORE INTO ${constraints} (record_id,marker) VALUES ('duplicate_${ns}','constraint_${ns}');`
      : `INSERT INTO ${constraints} (record_id,marker) VALUES ('row_${ns}','constraint_${ns}'); INSERT INTO ${constraints} (record_id,marker) VALUES ('duplicate_${ns}','constraint_${ns}') ON CONFLICT (marker) DO NOTHING;`;
    return {
      setup: `CREATE TABLE ${constraints} (record_id TEXT PRIMARY KEY, marker TEXT UNIQUE);`,
      mutation,
      verify: vendor === "turso"
        ? `SELECT (SELECT COUNT(*) FROM ${constraints} WHERE marker='constraint_${ns}') || '|' || (SELECT COUNT(*) FROM pragma_index_list('axarena_constraint_probe_${ns}') WHERE \"unique\" = 1);`
        : `SELECT (SELECT COUNT(*) FROM ${constraints} WHERE marker='constraint_${ns}') || '|' || (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='axarena_constraint_probe_${ns}' AND constraint_type IN ('PRIMARY KEY','UNIQUE'));`,
      cleanup: `DROP TABLE IF EXISTS ${constraints};`,
      expected: "1|2",
    };
  }
  if (taskId === "db-T19-transactional-record-recovery") {
    return {
      setup: `CREATE TABLE ${transactions} (marker TEXT PRIMARY KEY);`,
      // Keep the second write in autocommit mode: Nile's SQL proxy rejects a
      // second explicit BEGIN in one command batch after ROLLBACK, while the
      // first transaction still proves the recovery boundary we need.
      mutation: `BEGIN; INSERT INTO ${transactions} (marker) VALUES ('rollback_${ns}'); ROLLBACK; INSERT INTO ${transactions} (marker) VALUES ('committed_${ns}');`,
      verify: `SELECT (SELECT COUNT(*) FROM ${transactions} WHERE marker='rollback_${ns}') || '|' || (SELECT COUNT(*) FROM ${transactions} WHERE marker='committed_${ns}');`,
      cleanup: `DROP TABLE IF EXISTS ${transactions};`,
      expected: "0|1",
    };
  }
  if (taskId === "db-T20-aggregate-query") {
    return {
      setup: `CREATE TABLE ${aggregates} (label TEXT, status TEXT);`,
      mutation: `INSERT INTO ${aggregates} (label,status) VALUES ('alpha_${ns}','active'),('beta_${ns}','active'),('gamma_${ns}','inactive');`,
      verify: `SELECT (SELECT COUNT(*) FROM ${aggregates}) || '|' || (SELECT COUNT(*) FROM ${aggregates} WHERE status='active') || '|' || (SELECT COUNT(*) FROM ${aggregates} WHERE status='active');`,
      cleanup: `DROP TABLE IF EXISTS ${aggregates};`,
      expected: "3|2|2",
    };
  }
  if (taskId === "db-T22-negative-query-verification") {
    return {
      setup: `CREATE TABLE ${negative} (marker TEXT PRIMARY KEY);`,
      mutation: `INSERT INTO ${negative} (marker) VALUES ('present_a_${ns}'),('present_b_${ns}');`,
      verify: `SELECT (SELECT COUNT(*) FROM ${negative}) || '|' || (SELECT COUNT(*) FROM ${negative} WHERE marker='absent_${ns}');`,
      cleanup: `DROP TABLE IF EXISTS ${negative};`,
      expected: "2|0",
    };
  }
  if (taskId === "db-T02-evolve-schema") {
    return {
      setup: `CREATE TABLE ${migrate} (title TEXT);`,
      mutation: `ALTER TABLE ${migrate} ADD COLUMN status TEXT;`,
      verify: vendor === "turso"
        ? `SELECT COUNT(*) FROM pragma_table_info('axarena_migrate_${ns}') WHERE name IN ('title','status');`
        : `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='axarena_migrate_${ns}' AND column_name IN ('title','status');`,
      cleanup: `DROP TABLE IF EXISTS ${migrate};`,
      expected: "2",
    };
  }
  if (taskId === "db-T03-inspect-schema") {
    return {
      setup: `CREATE TABLE ${schema} (name TEXT, status TEXT);`,
      mutation: `INSERT INTO ${schema} (name,status) VALUES ('probe_${ns}','ready');`,
      verify: vendor === "turso"
        ? `SELECT COUNT(*) FROM pragma_table_info('axarena_schema_probe_${ns}') WHERE name IN ('name','status');`
        : `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='axarena_schema_probe_${ns}' AND column_name IN ('name','status');`,
      cleanup: `DROP TABLE IF EXISTS ${schema};`,
      expected: "2",
    };
  }
  if (taskId === "db-T04-query-records") {
    return {
      setup: `CREATE TABLE ${query} (label TEXT, status TEXT);`,
      mutation: `INSERT INTO ${query} (label,status) VALUES ('alpha_${ns}','active'),('beta_${ns}','inactive'),('gamma_${ns}','active');`,
      verify: `SELECT (SELECT COUNT(*) FROM ${query}) || '|' || (SELECT COUNT(*) FROM ${query} WHERE status='active') || '|' || (SELECT COUNT(*) FROM ${query} WHERE status='active' AND label IN ('alpha_${ns}','gamma_${ns}'));`,
      cleanup: `DROP TABLE IF EXISTS ${query};`,
      expected: "3|2|2",
    };
  }
  if (taskId === "db-T05-vector-search") {
    return {
      // Nile's SQL proxy rejects the CREATE EXTENSION command tag even when
      // pgvector is already provisioned on the disposable database. Require
      // the vector type at table creation, but avoid unsupported control-plane
      // DDL on this CLI path.
      setup: vendor === "turso"
        ? `CREATE TABLE ${vectors} (label TEXT, embedding BLOB);`
        : `${vendor === "cockroachdb" || vendor === "nile" ? "" : "CREATE EXTENSION IF NOT EXISTS vector;"} CREATE TABLE ${vectors} (label TEXT, embedding ${vectorType});`,
      mutation: vendor === "turso"
        ? `INSERT INTO ${vectors} (label,embedding) VALUES ('alpha_${ns}',vector32('[1,0,0]')),('beta_${ns}',vector32('[0,1,0]')),('gamma_${ns}',vector32('[0,0,1]'));`
        : `INSERT INTO ${vectors} (label,embedding) VALUES ('alpha_${ns}','[1,0,0]'),('beta_${ns}','[0,1,0]'),('gamma_${ns}','[0,0,1]');`,
      verify: vendor === "turso"
        ? `SELECT label FROM ${vectors} ORDER BY vector_distance_cos(embedding,vector32('[1,0,0]')) LIMIT 1;`
        : `SELECT label FROM ${vectors} ORDER BY embedding <-> '[1,0,0]' LIMIT 1;`,
      cleanup: `DROP TABLE IF EXISTS ${vectors};`,
      expected: `alpha_${ns}`,
    };
  }
  if (taskId === "db-T06-write-records") {
    return {
      setup: `CREATE TABLE ${writes} (record_id TEXT PRIMARY KEY, label TEXT);`,
      mutation: `INSERT INTO ${writes} (record_id,label) VALUES ('record_${ns}','draft_${ns}'),('delete_${ns}','delete_me_${ns}'); UPDATE ${writes} SET label='final_${ns}' WHERE record_id='record_${ns}'; DELETE FROM ${writes} WHERE record_id='delete_${ns}';`,
      verify: `SELECT (SELECT COUNT(*) FROM ${writes} WHERE record_id='record_${ns}' AND label='final_${ns}') || '|' || (SELECT COUNT(*) FROM ${writes} WHERE label='draft_${ns}') || '|' || (SELECT COUNT(*) FROM ${writes} WHERE label='delete_me_${ns}');`,
      cleanup: `DROP TABLE IF EXISTS ${writes};`,
      expected: "1|0|0",
    };
  }
  if (taskId === "db-T07-full-text-search") {
    const setup = vendor === "turso"
      ? `CREATE VIRTUAL TABLE ${search} USING fts5(content);`
      : `CREATE TABLE ${search} (content TEXT);`;
    const mutation = `INSERT INTO ${search} (content) VALUES ('orchard_${ns}'),('mountain_${ns}'),('harbor_${ns}');`;
    const match = vendor === "turso"
      ? `content MATCH 'orchard_${ns}'`
      : `to_tsvector('simple',content) @@ plainto_tsquery('simple','orchard_${ns}')`;
    return {
      setup,
      mutation,
      verify: `SELECT (SELECT COUNT(*) FROM ${search}) || '|' || (SELECT COUNT(*) FROM ${search} WHERE ${match}) || '|' || (SELECT COUNT(*) FROM ${search} WHERE ${match} AND (content LIKE '%mountain_${ns}%' OR content LIKE '%harbor_${ns}%'));`,
      cleanup: `DROP TABLE IF EXISTS ${search};`,
      expected: "3|1|0",
    };
  }
  throw new Error(`unsupported deterministic task ${taskId}`);
}

function writeStage(path: string, stage: V2StageRecord): void {
  writeFileSync(path, JSON.stringify(stage, null, 2), { mode: 0o600 });
}

function runStage(driver: V2Driver, sql: string, expected?: string): V2StageRecord {
  const result = driver.run(sql);
  const stage: V2StageRecord = {
    status: result.status === 0 ? "passed" : "failed",
    command: result.command,
    sql,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
    exit_code: result.status,
  };
  if (result.status !== 0) {
    const detail = result.stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    stage.error = `command exited ${result.status ?? "without a status"}${detail ? `: ${detail.slice(0, 240)}` : ""}`;
  } else if (expected !== undefined) {
    stage.observed = scalar(result);
    if (stage.observed !== expected) {
      stage.status = "failed";
      stage.error = `expected scalar ${expected}, observed ${stage.observed || "<empty>"}`;
    }
  }
  return stage;
}

function runAccessControlTask(driver: V2Driver, ns: string, cellDir: string): { ok: boolean; reason: string; stages: Record<string, V2StageRecord> } {
  const target = table(ns, "acl");
  const denied = role(ns);
  const setupSql = `CREATE TABLE ${target} (id INT PRIMARY KEY, owner TEXT);`;
  const setup = runStage(driver, setupSql);
  writeStage(resolve(cellDir, "setup.json"), setup);
  let mutation: V2StageRecord = { status: "failed", command: "not-run", sql: "", stdout: "", stderr: "", exit_code: null, error: "setup failed" };
  let verify: V2StageRecord = { status: "failed", command: "not-run", sql: "", stdout: "", stderr: "", exit_code: null, error: "setup failed" };
  let cleanup: V2StageRecord = { status: "failed", command: "not-run", sql: `DROP TABLE IF EXISTS ${target}; DROP ROLE IF EXISTS ${denied};`, stdout: "", stderr: "", exit_code: null, error: "cleanup not attempted" };
  try {
    if (setup.status === "passed") {
      const userResult = driver.run("SELECT current_user;");
      const currentUser = scalar(userResult).replace(/[^A-Za-z0-9_]/g, "_");
      if (!currentUser) {
        mutation = { status: "failed", command: userResult.command, sql: "SELECT current_user;", stdout: redact(userResult.stdout), stderr: redact(userResult.stderr), exit_code: userResult.status, error: "could not determine current SQL user" };
      } else {
        const mutationSql = `INSERT INTO ${target} (id,owner) VALUES (1,'authorized_${ns}'); CREATE ROLE ${denied} NOLOGIN; REVOKE ALL ON TABLE ${target} FROM PUBLIC; GRANT ${denied} TO "${currentUser}";`;
        mutation = runStage(driver, mutationSql);
      }
      writeStage(resolve(cellDir, "mutation.json"), mutation);
      if (mutation.status === "passed") {
        const authorized = runStage(driver, `SELECT COUNT(*) FROM ${target};`, "1");
        const deniedResult = driver.run(`SET ROLE ${denied}; SELECT COUNT(*) FROM ${target};`);
        const deniedStage: V2StageRecord = {
          status: deniedResult.status === 0 ? "failed" : "passed",
          command: deniedResult.command,
          sql: `SET ROLE ${denied}; SELECT COUNT(*) FROM ${target};`,
          stdout: redact(deniedResult.stdout),
          stderr: redact(deniedResult.stderr),
          exit_code: deniedResult.status,
          error: deniedResult.status === 0 ? "denied role unexpectedly read the protected table" : undefined,
        };
        verify = {
          status: authorized.status === "passed" && deniedStage.status === "passed" ? "passed" : "failed",
          command: `${authorized.command}; ${deniedStage.command}`,
          sql: `${authorized.sql}\n${deniedStage.sql}`,
          stdout: `${authorized.stdout}\n${deniedStage.stdout}`,
          stderr: `${authorized.stderr}\n${deniedStage.stderr}`,
          exit_code: deniedStage.status === "passed" ? 0 : deniedResult.status,
          error: authorized.status !== "passed" ? authorized.error : deniedStage.error,
        };
        writeStage(resolve(cellDir, "verify.json"), verify);
      }
    }
  } finally {
    cleanup = runStage(driver, `DROP TABLE IF EXISTS ${target}; DROP ROLE IF EXISTS ${denied};`);
    writeStage(resolve(cellDir, "cleanup.json"), cleanup);
  }
  const stages = { setup, mutation, verify, cleanup };
  const ok = setup.status === "passed" && mutation.status === "passed" && verify.status === "passed" && cleanup.status === "passed";
  return { ok, reason: !ok ? verify.error ?? mutation.error ?? setup.error ?? cleanup.error ?? "access-control witness failed" : "", stages };
}

export function runV2DeterministicTask(driver: V2Driver, taskId: string, ns: string, cellDir: string): { ok: boolean; reason: string; stages: Record<string, V2StageRecord> } {
  if (taskId === "db-T01-access-control") return runAccessControlTask(driver, ns, cellDir);
  const plan = sqlPlan(driver.vendor, taskId, ns);
  const setup = runStage(driver, plan.setup);
  writeStage(resolve(cellDir, "setup.json"), setup);
  let mutation: V2StageRecord = { status: "failed", command: "not-run", sql: plan.mutation, stdout: "", stderr: "", exit_code: null, error: "setup failed" };
  let verify: V2StageRecord = { status: "failed", command: "not-run", sql: plan.verify, stdout: "", stderr: "", exit_code: null, error: "setup failed" };
  let cleanup: V2StageRecord = { status: "failed", command: "not-run", sql: plan.cleanup, stdout: "", stderr: "", exit_code: null, error: "cleanup not attempted" };
  try {
    if (setup.status === "passed") {
      mutation = runStage(driver, plan.mutation);
      writeStage(resolve(cellDir, "mutation.json"), mutation);
      if (mutation.status === "passed") {
        verify = runStage(driver, plan.verify, plan.expected);
        writeStage(resolve(cellDir, "verify.json"), verify);
      }
    }
  } finally {
    cleanup = runStage(driver, plan.cleanup);
    writeStage(resolve(cellDir, "cleanup.json"), cleanup);
  }
  const ok = setup.status === "passed" && mutation.status === "passed" && verify.status === "passed" && cleanup.status === "passed";
  return {
    ok,
    reason: !ok ? mutation.error ?? verify.error ?? setup.error ?? cleanup.error ?? "witness failed" : "",
    stages: { setup, mutation, verify, cleanup },
  };
}

export function proofForV2Task(packPath: string, runRoot: string, cellDir: string, stages: Record<string, V2StageRecord>): V2WitnessProof {
  const stagePath = (name: string) => resolve(cellDir, name).replace(`${resolve(runRoot)}/`, "");
  const stage = (name: string) => ({ status: "passed" as const, command: stages[name]!.command, artifact: stagePath(`${name}.json`) });
  const bundle = JSON.stringify(stages);
  return {
    setup: stage("setup"),
    mutation: stage("mutation"),
    verify: stage("verify"),
    cleanup: stage("cleanup"),
    source_sha256: sha256File(packPath),
    bundle_sha256: sha256(bundle),
  };
}

export function runV2Witness(options: V2WitnessRunOptions): V2WitnessRunManifest {
  loadDotenv(resolve(options.benchmarkRoot, "..", "..", "..", ".env"));
  if (!options.apply) throw new Error("run-v2-witness requires --apply because it performs sandbox writes");
  const v2Root = resolve(options.benchmarkRoot, "v2");
  const planPath = resolve(v2Root, "witness-plan.yaml");
  if (!existsSync(planPath)) throw new Error(`missing v2 witness plan: ${planPath}`);
  const plan = yamlParse(readFileSync(planPath, "utf8")) as V2WitnessPlan;
  if (plan.mode !== "cli-only") throw new Error("run-v2-witness only runs the canonical cli-only plan");
  const vendorFilter = options.vendors?.length ? new Set(options.vendors) : undefined;
  const taskFilter = options.tasks?.length ? new Set(options.tasks) : undefined;
  mkdirSync(options.runRoot, { recursive: true, mode: 0o700 });
  const generatedAt = new Date().toISOString();
  const repositoryRoot = resolve(options.benchmarkRoot, "..", "..", "..");
  const evidencePath = (artifactDir: string) => relative(repositoryRoot, resolve(options.runRoot, artifactDir));
  const manifest: V2WitnessRunManifest = { schema: "ax.daeb-v2-witness-run/v1", benchmark: "DAEB-2", generated_at: generatedAt, mode: "cli-only", run_root: options.runRoot, apply: true, cells: [] };
  for (const entry of plan.entries) {
    if (vendorFilter && !vendorFilter.has(entry.vendor)) continue;
    if (taskFilter && !taskFilter.has(entry.task_id)) continue;
    const packPath = resolve(v2Root, "packs", entry.vendor, "pack.yaml");
    const cellDir = resolve(options.runRoot, "cells", safeSegment(entry.vendor), safeSegment(entry.task_id));
    mkdirSync(cellDir, { recursive: true, mode: 0o700 });
    const productionTargetIssue = options.production && entry.vendor === "cockroachdb"
      ? cockroachProductionTargetIssue(process.env.COCKROACH_CONNECTION_STRING)
      : undefined;
    if (productionTargetIssue) {
      writeStage(resolve(cellDir, "blocked.json"), { status: "failed", command: "production-target-preflight", sql: "", stdout: "", stderr: productionTargetIssue, exit_code: null, error: productionTargetIssue });
      manifest.cells.push({ vendor: entry.vendor, task_id: entry.task_id, status: "blocked", reason: productionTargetIssue, artifact_dir: cellDir.replace(`${resolve(options.runRoot)}/`, "") });
      continue;
    }
    const driver = makeV2Driver(entry.vendor);
    if (driver.missingEnv.length) {
      const reason = `missing required CLI credential/context: ${driver.missingEnv.join(", ")}`;
      writeStage(resolve(cellDir, "blocked.json"), { status: "failed", command: "blocked", sql: "", stdout: "", stderr: reason, exit_code: null, error: reason });
      manifest.cells.push({ vendor: entry.vendor, task_id: entry.task_id, status: "blocked", reason, artifact_dir: cellDir.replace(`${resolve(options.runRoot)}/`, "") });
      continue;
    }
    const ns = `v2_${safeSegment(entry.vendor)}_${safeSegment(entry.task_id.replace(/^db-T/, "t"))}_${Date.now().toString(36)}`;
    const result = runV2DeterministicTask(driver, entry.task_id, ns, cellDir);
    const stageNames = ["setup", "mutation", "verify", "cleanup"] as const;
    const allStageFiles = stageNames.every((name) => existsSync(resolve(cellDir, `${name}.json`)));
    const proof = result.ok && allStageFiles ? proofForV2Task(packPath, options.runRoot, cellDir, Object.fromEntries(stageNames.map((name) => [name, JSON.parse(readFileSync(resolve(cellDir, `${name}.json`), "utf8"))])) as Record<string, V2StageRecord>) : undefined;
    manifest.cells.push({ vendor: entry.vendor, task_id: entry.task_id, status: result.ok ? "passed" : "failed", reason: result.reason, artifact_dir: cellDir.replace(`${resolve(options.runRoot)}/`, ""), ...(proof ? { proof } : {}) });
  }
  writeFileSync(resolve(options.runRoot, "run-manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const updatedPlan: V2WitnessPlan = {
    ...plan,
    entries: plan.entries.map((entry) => {
      const cell = manifest.cells.find((candidate) => candidate.vendor === entry.vendor && candidate.task_id === entry.task_id);
      if (!cell) return entry;
      if (cell.status === "blocked") {
        return {
          ...entry,
          disposition: "blocked",
          reason: cell.reason || "witness blocked by missing credential or context",
          evidence: [evidencePath(cell.artifact_dir)],
        };
      }
      if (cell.status === "failed") {
        return {
          ...entry,
          disposition: "needs_witness",
          reason: `deterministic CLI witness failed: ${cell.reason || "see stage artifacts"}`,
          evidence: [evidencePath(cell.artifact_dir)],
        };
      }
      if (cell.status !== "passed" || !cell.proof) return entry;
      return { ...entry, disposition: "passed", reason: "deterministic CLI witness passed setup, mutation, independent read-back, and cleanup", evidence: [evidencePath(cell.artifact_dir)], proof: cell.proof };
    }),
  };
  const errors = validateV2WitnessPlan(updatedPlan);
  if (errors.length) throw new Error(`witness results would produce an invalid v2 plan:\n${errors.join("\n")}`);
  writeFileSync(planPath, yamlStringify(updatedPlan), { mode: 0o600 });
  const support: V2SupportMatrix = buildV2SupportMatrix(updatedPlan);
  writeFileSync(resolve(v2Root, "support-matrix.yaml"), yamlStringify(support), { mode: 0o600 });
  return manifest;
}
