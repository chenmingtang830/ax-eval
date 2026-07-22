import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

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
  "targets/README.md",
  "benchmarks/daeb/README.md",
  "benchmarks/daeb/v1/suite.yaml",
  "benchmarks/daeb/v1/suite.methodology.yaml",
  "benchmarks/daeb/v1/suite.concept-universe.yaml",
  "benchmarks/daeb/v1/suite.coverage-matrix.yaml",
  "benchmarks/daeb/v1/suite.selection-ledger.yaml",
  "benchmarks/daeb/v1/suite.support-matrix.yaml",
  "benchmarks/daeb/v1/suite.grader-ledger.yaml",
  "benchmarks/daeb/v1/suite.failure-taxonomy.yaml",
  "benchmarks/daeb/v1/suite.trace-review.yaml",
  "benchmarks/daeb/v1/suite.audit-notes.md",
  "benchmarks/daeb/v1/suite.synthesis.md",
  "benchmarks/daeb/v1/suite.support-summary.md",
  "benchmarks/daeb/v1/run-matrix.yaml",
  "benchmarks/daeb/v1/vendor-selection-ledger.yaml",
]);
for (const entry of readdirSync(resolve(process.cwd(), "targets", "examples"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  for (const name of ["pack.yaml", "pack.approval.json"]) {
    const path = `targets/examples/${entry.name}/${name}`;
    if (existsSync(resolve(process.cwd(), path))) required.add(path);
  }
}
for (const entry of readdirSync(resolve(process.cwd(), "benchmarks", "daeb", "v1", "packs"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  required.add(`benchmarks/daeb/v1/packs/${entry.name}/pack.yaml`);
  required.add(`benchmarks/daeb/v1/packs/${entry.name}/pack.approval.json`);
}

const missing = [...required].filter((path) => !files.has(path));
const forbidden = [...files].filter((path) =>
  path === ".env"
  || path.startsWith("docs/")
  || path.startsWith("results/")
  || path.includes("/_archive/")
  || path.startsWith("node_modules/"),
);
if (missing.length || forbidden.length) {
  throw new Error([
    missing.length ? `missing required package files: ${missing.join(", ")}` : "",
    forbidden.length ? `forbidden package files: ${forbidden.join(", ")}` : "",
  ].filter(Boolean).join("; "));
}

// A package self-reference exercises package.json exports, not only the file.
const publicApi = await import("ax-eval");
const requiredExports = [
  "TargetPackSchema",
  "BearerClient",
  "checkApproval",
  "verifyGeneratedPack",
  "registerOracleProvider",
  "aggregateNormalizedResults",
  "SURFACE_IDS",
  "INVOKE_HARNESS_IDS",
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
