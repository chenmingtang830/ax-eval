#!/usr/bin/env node
/** Derive exact, vendor-scoped V2.3 atomic packs from immutable V2.1 sources. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { loadPack } from "ax-eval";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const SUITE = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/vendor-experience-suite.yaml");
const SOURCE_ROOT = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-1/packs");
const OUTPUT_ROOT = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/packs");
type Task = { id: string; admitted_vendors: string[]; structural_na_vendors: string[] };
type Suite = { status: string; vendors: string[]; tasks: Task[] };
type RawPack = Record<string, unknown> & { tasks?: Array<Record<string, unknown>> };
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const repoPath = (path: string) => relative(ROOT, path).split(sep).join("/");
const scopeByVendor: Record<string, Array<{ name: string; env: string; required: boolean; instructions: string }>> = {
  cockroachdb: [
    { name: "cluster_id", env: "COCKROACH_CLUSTER_ID", required: true, instructions: "existing dedicated CockroachDB sandbox cluster; do not create or modify another cluster" },
    { name: "database", env: "COCKROACH_DATABASE", required: true, instructions: "existing dedicated database named by the CockroachDB sandbox connection" },
  ],
  insforge: [
    { name: "project_url", env: "INSFORGE_PROJECT_URL", required: true, instructions: "existing dedicated InsForge sandbox project URL; do not create or modify another project" },
  ],
  neon: [],
  nile: [],
  supabase: [
    { name: "project_ref", env: "SUPABASE_PROJECT_REF", required: true, instructions: "existing dedicated Supabase sandbox project reference; do not create or modify another project" },
    { name: "project_url", env: "SUPABASE_URL", required: true, instructions: "existing dedicated Supabase sandbox URL corresponding to SUPABASE_PROJECT_REF" },
  ],
  turso: [
    { name: "organization", env: "TURSO_ORG", required: true, instructions: "existing dedicated Turso sandbox organization" },
    { name: "database", env: "TURSO_SANDBOX_DATABASE", required: true, instructions: "existing dedicated Turso sandbox database" },
    { name: "database_url", env: "TURSO_DATABASE_URL", required: true, instructions: "database URL for the declared Turso sandbox database" },
  ],
};

const suite = parse(readFileSync(SUITE, "utf8")) as Suite;
if (suite.status !== "frozen") throw new Error(`V2.3 packs require a frozen suite, got ${suite.status}`);
const atomic = suite.tasks.filter((task) => task.id !== "db-J01-native-journey");
const manifest: Record<string, unknown> = {
  schema: "ax.daeb-v2-3-derived-pack-manifest/v1",
  suite: { path: repoPath(SUITE), sha256: sha256(readFileSync(SUITE)) },
  generation: "deterministic-task-subset-from-v2-1",
  vendors: {},
};
for (const vendor of suite.vendors) {
  const sourcePath = resolve(SOURCE_ROOT, vendor, "pack.yaml");
  const sourceBytes = readFileSync(sourcePath);
  const source = parse(sourceBytes.toString("utf8")) as RawPack;
  const ids = new Set(atomic.filter((task) => task.admitted_vendors.includes(vendor) || task.structural_na_vendors.includes(vendor)).map((task) => task.id));
  const tasks = (source.tasks ?? []).filter((task) => typeof task.id === "string" && ids.has(task.id));
  if (tasks.length !== ids.size) throw new Error(`${vendor}: selected ${tasks.length}/${ids.size} V2.3 atomic tasks`);
  const derived: RawPack = {
    ...source,
    version: "2.3-frozen",
    standard_set_version: "daeb-2-3-cli-vendor-experience-v1",
    run_id: `daeb23-${vendor}`,
    generated_by: "v2-3-frozen-task-subset-derivation",
    sandbox_scope: scopeByVendor[vendor]?.length ? scopeByVendor[vendor] : source.sandbox_scope,
    tasks,
  };
  const destination = resolve(OUTPUT_ROOT, vendor, "pack.yaml");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, stringify(derived), { mode: 0o600 });
  loadPack(destination);
  (manifest.vendors as Record<string, unknown>)[vendor] = {
    source_pack: repoPath(sourcePath),
    source_sha256: sha256(sourceBytes),
    pack: repoPath(destination),
    pack_sha256: sha256(readFileSync(destination)),
    task_ids: tasks.map((task) => task.id),
  };
}
writeFileSync(resolve(OUTPUT_ROOT, "derived-pack-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ output_root: OUTPUT_ROOT, vendors: suite.vendors, suite_sha256: (manifest.suite as { sha256: string }).sha256 }, null, 2));
