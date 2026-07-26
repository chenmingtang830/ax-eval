import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import ts from "typescript";
import {
  DETACHED_ARENA_DATABASE_DEPENDENCIES,
  declaredPackageDependencies,
} from "./verify-import-boundaries.mjs";

const npm = process.env.npm_execpath
  ? { command: process.execPath, args: [process.env.npm_execpath] }
  : { command: "npm", args: [] };

function collectDeclarationExports(path) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set();
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
      continue;
    }
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if ("name" in statement && statement.name && ts.isIdentifier(statement.name)) names.add(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
  }
  return names;
}
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
  throw new Error(`core package declares arena-owned database dependencies: ${leakedDatabaseDependencies.join(", ")}`);
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
  "REPORT_STYLE",
  "runCell",
  "runCellWithRuntime",
  "SURFACE_IDS",
  "INVOKE_HARNESS_IDS",
  "CAPABILITY_INVENTORY_SCHEMA_VERSION",
  "CapabilityEvidenceSchema",
  "CapabilityInventorySchema",
  "SuiteMethodologySchema",
  "SurfaceExtractResultSchema",
  "OracleCheckSchema",
  "OracleExtractItemSchema",
  "OracleExtractResultSchema",
  "OracleVendorConfigSchema",
  "ResolveResultSchema",
  "extractCapabilities",
  "loadSuite",
  "resolveVendors",
];
const missingExports = requiredExports.filter((name) => !(name in publicApi));
if (missingExports.length) {
  throw new Error(`missing public API exports: ${missingExports.join(", ")}`);
}
const detachedArenaExports = [
  "ConceptClusterSchema",
  "ConceptCoverageSchema",
  "ConceptUniverseSchema",
  "CoverageDecisionSchema",
  "CoverageMatrixSchema",
  "FailureTaxonomySchema",
  "GraderLedgerEntrySchema",
  "GraderLedgerSchema",
  "SelectionLedgerEntrySchema",
  "SelectionLedgerSchema",
  "SupportMatrixEntrySchema",
  "SupportMatrixSchema",
  "TraceReviewMemoSchema",
  "auditCapabilityInventory",
  "applySuiteAudit",
  "composePack",
  "createDaebPathContext",
  "defaultSuiteMethodology",
  "extractOracles",
  "extractOraclesAll",
  "loadCapabilityExtract",
  "loadOracleExtract",
  "loadSupportMatrix",
  "loadSurfaceExtract",
  "loadVendorCard",
  "writeCapabilityExtract",
  "writeComposedPack",
  "writeExtractAdvisory",
  "writeOracleExtract",
  "writeSupportMatrix",
  "writeSurfaceExtract",
  "writeSuiteArtifacts",
  "writeSuiteBundle",
  "writeSuiteFiles",
  "writeVendorCard",
]
  .filter((name) => name in publicApi);
if (detachedArenaExports.length) {
  throw new Error(`core package exposes arena-owned API exports: ${detachedArenaExports.join(", ")}`);
}
const declarationApi = collectDeclarationExports(resolve(process.cwd(), "dist", "index.d.ts"));
const requiredTypeExports = ["CapabilityInventory", "CapabilityInventoryEntry", "SuiteMethodology"];
const missingTypeExports = requiredTypeExports.filter((name) => !declarationApi.has(name));
const detachedArenaTypeExports = [
  "ConceptCluster",
  "ConceptUniverse",
  "CoverageDecision",
  "CoverageMatrix",
  "FailureTaxonomy",
  "GraderLedger",
  "GraderLedgerEntry",
  "SelectionLedger",
  "SelectionLedgerEntry",
  "SupportMatrix",
  "SupportMatrixEntry",
  "TraceReviewMemo",
].filter((name) => declarationApi.has(name));
if (missingTypeExports.length || detachedArenaTypeExports.length) {
  throw new Error([
    missingTypeExports.length ? `missing core declaration exports: ${missingTypeExports.join(", ")}` : "",
    detachedArenaTypeExports.length ? `core declarations expose arena-owned types: ${detachedArenaTypeExports.join(", ")}` : "",
  ].filter(Boolean).join("; "));
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
