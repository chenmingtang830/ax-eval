import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  DETACHED_ARENA_DATABASE_DEPENDENCIES,
  declaredPackageDependencies,
} from "./verify-import-boundaries.mjs";

const npm = process.env.npm_execpath
  ? { command: process.execPath, args: [process.env.npm_execpath] }
  : { command: "npm", args: [] };
const result = spawnSync(npm.command, [...npm.args, "--cache", ".npm-cache", "pack", "--dry-run", "--json"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
if (result.error || result.status !== 0) {
  throw new Error(result.error?.message || result.stderr || `npm pack exited ${result.status}`);
}

const report = JSON.parse(result.stdout)[0];
const files = new Set((report?.files ?? []).map((file) => file.path));
const required = new Set([
  ".env.example",
  "README.md",
  "SKILL.md",
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
  "schemas/normalized-result.v1.json",
  "schemas/evaluation-cell.v1.json",
  "schemas/normalized-cell-record.v1.json",
  "targets/README.md",
]);
for (const entry of readdirSync(resolve(process.cwd(), "targets", "examples"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  for (const name of ["pack.yaml", "pack.approval.json"]) {
    const path = `targets/examples/${entry.name}/${name}`;
    if (existsSync(resolve(process.cwd(), path))) required.add(path);
  }
}
const missing = [...required].filter((path) => !files.has(path));
const forbidden = [...files].filter((path) =>
  path === ".env"
  || path.startsWith("docs/")
  || path.startsWith("results/")
  || path.startsWith("ax-arena/")
  || path.startsWith("benchmarks/daeb/")
  || path.includes("/_archive/")
  || path.startsWith("node_modules/"),
);
const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
const rootDependencies = declaredPackageDependencies(manifest);
const leakedDatabaseDependencies = DETACHED_ARENA_DATABASE_DEPENDENCIES
  .filter((name) => name in rootDependencies);
if (missing.length || forbidden.length) {
  throw new Error([
    missing.length ? `missing required package files: ${missing.join(", ")}` : "",
    forbidden.length ? `forbidden package files: ${forbidden.join(", ")}` : "",
  ].filter(Boolean).join("; "));
}
if (leakedDatabaseDependencies.length) {
  throw new Error(`core package declares unused arena database dependencies: ${leakedDatabaseDependencies.join(", ")}`);
}

// A package self-reference exercises package.json exports, not only the file.
const publicApi = await import("ax-eval");
const requiredExports = [
  "BearerClient",
  "TargetPackSchema",
  "BearerClient",
  "checkApproval",
  "checkCellApproval",
  "checkCommittedLegacyCellApproval",
  "verifyGeneratedPack",
  "createOracleProviderRegistry",
  "registerOracleProvider",
  "aggregateNormalizedResults",
  "EvaluationCellSchema",
  "NORMALIZED_CELL_RECORD_SCHEMA",
  "NormalizedCellRecordSchema",
  "runCell",
  "runCellWithRuntime",
  "SURFACE_IDS",
  "INVOKE_HARNESS_IDS",
  "CapabilityInventorySchema",
  "SurfaceExtractResultSchema",
  "OracleExtractResultSchema",
  "ResolveResultSchema",
  "createDaebPathContext",
  "extractCapabilities",
  "loadSuite",
  "resolveVendors",
];
const missingExports = requiredExports.filter((name) => !(name in publicApi));
if (missingExports.length) {
  throw new Error(`missing public API exports: ${missingExports.join(", ")}`);
}

const declaration = readFileSync(resolve(process.cwd(), "dist", "index.d.ts"), "utf8");
const declarationExports = declaration.match(/export\s*\{[^}]+\}/gs)?.join("\n") ?? "";
for (const name of ["BearerClientOptions", "DiscoveryResult", "ObservedRun", "ProfileRun"]) {
  if (!new RegExp(`\\b${name}\\b`).test(declarationExports)) {
    throw new Error(`missing public declaration type: ${name}`);
  }
}

const schemaUrl = import.meta.resolve("ax-eval/schemas/normalized-result.v1.json");
if (!schemaUrl.endsWith("/schemas/normalized-result.v1.json")) {
  throw new Error("normalized-result schema subpath did not resolve through package exports");
}

console.log(`Verified ${files.size} package files (${report.filename}).`);
