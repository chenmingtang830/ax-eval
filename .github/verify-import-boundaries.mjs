import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
export const DETACHED_ARENA_DATABASE_DEPENDENCIES = Object.freeze([
  "@neondatabase/api-client",
  "@neondatabase/serverless",
  "@supabase/supabase-js",
  "supabase",
  "mongodb",
  "mysql2",
  "pg",
  "@types/pg",
]);
export const DETACHED_ARENA_POLICY_FILES = Object.freeze([
  "src/generate/benchmark-paths.ts",
  "src/generate/compose-pack.ts",
  "src/generate/database-pack-overrides.ts",
  "src/generate/low-pass.ts",
  "src/generate/production-run.ts",
  "src/generate/publication.ts",
  "src/generate/task-extract.ts",
]);
export const DETACHED_ARENA_CORE_DECLARATIONS = Object.freeze([
  { path: "src/generate/report.ts", identifier: "renderCompetitiveReport" },
  { path: "src/harness/mcp-provision.ts", identifier: "ensureTursoCli" },
  { path: "src/generate/capability-extract.ts", identifier: "capabilityExtractPath" },
  { path: "src/generate/capability-extract.ts", identifier: "loadCapabilityExtract" },
  { path: "src/generate/capability-extract.ts", identifier: "writeCapabilityExtract" },
  { path: "src/generate/methodology.ts", identifier: "loadCapabilityInventory" },
  { path: "src/generate/methodology.ts", identifier: "defaultSuiteMethodology" },
  { identifier: "ConceptCoverageSchema" },
  { identifier: "ConceptClusterSchema" },
  { identifier: "ConceptCluster" },
  { identifier: "ConceptUniverseSchema" },
  { identifier: "ConceptUniverse" },
  { identifier: "CoverageDecisionSchema" },
  { identifier: "CoverageDecision" },
  { identifier: "CoverageMatrixSchema" },
  { identifier: "CoverageMatrix" },
  { identifier: "SelectionLedgerEntrySchema" },
  { identifier: "SelectionLedgerEntry" },
  { identifier: "SelectionLedgerSchema" },
  { identifier: "SelectionLedger" },
  { identifier: "SupportMatrixEntrySchema" },
  { identifier: "SupportMatrixEntry" },
  { identifier: "SupportMatrixSchema" },
  { identifier: "SupportMatrix" },
  { identifier: "GraderLedgerEntrySchema" },
  { identifier: "GraderLedgerEntry" },
  { identifier: "GraderLedgerSchema" },
  { identifier: "GraderLedger" },
  { identifier: "FailureTaxonomySchema" },
  { identifier: "FailureTaxonomy" },
  { identifier: "TraceReviewMemoSchema" },
  { identifier: "TraceReviewMemo" },
  { identifier: "auditCapabilityInventory" },
  { path: "src/generate/methodology.ts", identifier: "writeCapabilityInventory" },
  { path: "src/generate/methodology.ts", identifier: "writeMethodology" },
  { path: "src/generate/methodology.ts", identifier: "writeSupportMatrix" },
  { path: "src/generate/surface-extract.ts", identifier: "loadSurfaceExtract" },
  { path: "src/generate/surface-extract.ts", identifier: "writeSurfaceExtract" },
  { path: "src/generate/task-extract.ts", identifier: "loadOracleExtract" },
  { path: "src/generate/task-extract.ts", identifier: "writeOracleExtract" },
  { path: "src/generate/vendor-resolve.ts", identifier: "loadVendorCard" },
  { path: "src/generate/vendor-resolve.ts", identifier: "writeVendorCard" },
]);
export const DETACHED_ARENA_CORE_TEXT_PATTERNS = Object.freeze([
  {
    pattern: /NILE_(?:DB|DATABASE_URL)|Nile sandbox binding/,
    label: "Nile credential-scope policy",
  },
]);

export function declaredPackageDependencies(packageJson) {
  return {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.optionalDependencies,
    ...packageJson.peerDependencies,
  };
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function filesUnder(root) {
  if (!existsSync(root)) return { files: [], symlinks: [] };
  const files = [];
  const symlinks = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isSymbolicLink()) symlinks.push(child);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(child);
    }
  };
  visit(root);
  return { files, symlinks };
}

function physicalTarget(path) {
  const suffix = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    suffix.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

function moduleSpecifiers(path) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const add = (node) => {
    if (node && ts.isStringLiteralLike(node)) specifiers.push({ value: node.text, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1) add(node.arguments[0]);
      if (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function declaredIdentifiers(path) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const identifiers = new Set();
  const visit = (node) => {
    if ((ts.isFunctionDeclaration(node)
      || ts.isClassDeclaration(node)
      || ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node)
      || ts.isEnumDeclaration(node)) && node.name) {
      identifiers.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) identifiers.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return identifiers;
}

export function findImportBoundaryViolations(root = process.cwd()) {
  const repoRoot = resolve(root);
  const coreRoot = resolve(repoRoot, "src");
  const arenaRoot = resolve(repoRoot, "ax-arena", "benchmark");
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  const publicExports = new Set(Object.keys(packageJson.exports ?? {}));
  const violations = [];

  for (const path of DETACHED_ARENA_POLICY_FILES) {
    if (existsSync(resolve(repoRoot, path))) {
      violations.push(`${path} is an arena-owned policy implementation and must not exist in core`);
    }
  }

  const coreDependencies = declaredPackageDependencies(packageJson);
  const detachedDatabaseDependencies = new Set(DETACHED_ARENA_DATABASE_DEPENDENCIES);
  for (const dependency of DETACHED_ARENA_DATABASE_DEPENDENCIES) {
    if (dependency in coreDependencies) {
      violations.push(`package.json core must not declare detached arena dependency ${dependency}`);
    }
  }

  const coreScan = filesUnder(coreRoot);
  for (const symlink of coreScan.symlinks) {
    violations.push(`${relative(repoRoot, symlink)} source boundary scan rejects symlinks`);
  }
  for (const file of coreScan.files) {
    const corePath = relative(repoRoot, file).split(sep).join("/");
    const sourceText = readFileSync(file, "utf8");
    for (const rule of DETACHED_ARENA_CORE_TEXT_PATTERNS) {
      if (rule.pattern.test(sourceText)) {
        violations.push(`${corePath} must not contain arena-owned ${rule.label}`);
      }
    }
    for (const rule of DETACHED_ARENA_CORE_DECLARATIONS) {
      if ((!rule.path || corePath === rule.path) && declaredIdentifiers(file).has(rule.identifier)) {
        violations.push(`${corePath} must not declare arena-owned ${rule.identifier}`);
      }
    }
    for (const specifier of moduleSpecifiers(file)) {
      const detachedDependency = [...detachedDatabaseDependencies]
        .find((dependency) => specifier.value === dependency || specifier.value.startsWith(`${dependency}/`));
      if (detachedDependency) {
        violations.push(`${relative(repoRoot, file)}:${specifier.line} core must not import arena database dependency ${specifier.value}`);
      }
      const relativeTarget = specifier.value.startsWith(".") ? resolve(dirname(file), specifier.value) : undefined;
      const physicalRelativeTarget = relativeTarget ? physicalTarget(relativeTarget) : undefined;
      if (specifier.value === "@ax-arena/benchmark"
        || specifier.value.startsWith("@ax-arena/benchmark/")
        || (physicalRelativeTarget && contained(realpathSync(arenaRoot), physicalRelativeTarget))) {
        violations.push(`${relative(repoRoot, file)}:${specifier.line} core must not import arena module ${specifier.value}`);
      }
    }
  }

  const arenaScans = ["src", "tests", "scripts"].map((dir) => filesUnder(resolve(arenaRoot, dir)));
  for (const symlink of arenaScans.flatMap((scan) => scan.symlinks)) {
    violations.push(`${relative(repoRoot, symlink)} source boundary scan rejects symlinks`);
  }
  const arenaFiles = arenaScans.flatMap((scan) => scan.files);
  for (const file of arenaFiles) {
    for (const specifier of moduleSpecifiers(file)) {
      if (specifier.value.startsWith(".")) {
        const target = resolve(dirname(file), specifier.value);
        if (!contained(arenaRoot, target) || !contained(realpathSync(arenaRoot), physicalTarget(target))) {
          violations.push(`${relative(repoRoot, file)}:${specifier.line} arena relative import escapes its workspace: ${specifier.value}`);
        }
        continue;
      }
      if (specifier.value === "ax-eval") continue;
      if (specifier.value.startsWith("ax-eval/")) {
        const exportedPath = `./${specifier.value.slice("ax-eval/".length)}`;
        if (!publicExports.has(exportedPath)) {
          violations.push(`${relative(repoRoot, file)}:${specifier.line} arena must use a public ax-eval export: ${specifier.value}`);
        }
      }
    }
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const violations = findImportBoundaryViolations();
  if (violations.length) throw new Error(`Import boundary violations:\n${violations.join("\n")}`);
  console.log("Verified ax-eval → ax-arena import boundaries.");
}
