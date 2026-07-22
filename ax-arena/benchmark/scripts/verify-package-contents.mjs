import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const npm = process.env.npm_execpath
  ? { command: process.execPath, args: [process.env.npm_execpath] }
  : { command: "npm", args: [] };
const result = spawnSync(npm.command, [...npm.args, "--cache", "../../.npm-cache", "pack", "--dry-run", "--json"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
if (result.error || result.status !== 0) {
  throw new Error(result.error?.message || result.stderr || `npm pack exited ${result.status}`);
}

const report = JSON.parse(result.stdout)[0];
const files = new Set((report?.files ?? []).map((file) => file.path));
const required = ["README.md", "dist/cli.js", "dist/index.js", "dist/index.d.ts", "package.json"];
function requireTree(directory, prefix) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = resolve(directory, entry.name);
    const path = `${prefix}/${entry.name}`;
    if (path === "daeb/_archive") continue;
    if (entry.isSymbolicLink()) throw new Error(`arena package source rejects symlink: ${path}`);
    if (entry.isDirectory()) requireTree(child, path);
    else if (entry.isFile()) required.push(path);
  }
}
requireTree(resolve(process.cwd(), "daeb"), "daeb");
const missing = required.filter((path) => !files.has(path));
const forbidden = [...files].filter((path) =>
  path.startsWith("src/")
  || path.startsWith("tests/")
  || path.startsWith("scripts/")
  || path.startsWith("benchmarks/daeb/")
  || path === "daeb/_archive"
  || path.startsWith("daeb/_archive/"),
);
if (missing.length || forbidden.length) {
  throw new Error([
    missing.length ? `missing required arena package files: ${missing.join(", ")}` : "",
    forbidden.length ? `forbidden arena package files: ${forbidden.join(", ")}` : "",
  ].filter(Boolean).join("; "));
}

const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
if (packageJson.bin?.["ax-arena"] !== "./dist/cli.js") {
  throw new Error("arena package ax-arena bin must target ./dist/cli.js");
}
const builtBin = spawnSync(process.execPath, [resolve(process.cwd(), "dist", "cli.js"), "benchmark", "--help"], {
  encoding: "utf8",
});
if (builtBin.error || builtBin.status !== 0 || !builtBin.stdout.includes("usage: ax-arena benchmark")) {
  throw new Error(builtBin.error?.message || builtBin.stderr || "built ax-arena binary did not print benchmark help");
}

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const smokeRoot = mkdtempSync(resolve(tmpdir(), "ax-arena-package-smoke-"));
try {
  const installedCore = resolve(smokeRoot, "node_modules", "ax-eval");
  const installedArena = resolve(smokeRoot, "node_modules", "@ax-arena", "benchmark");
  mkdirSync(installedCore, { recursive: true });
  mkdirSync(installedArena, { recursive: true });
  cpSync(resolve(workspaceRoot, "dist"), resolve(installedCore, "dist"), { recursive: true });
  cpSync(resolve(workspaceRoot, "package.json"), resolve(installedCore, "package.json"));
  cpSync(resolve(process.cwd(), "dist"), resolve(installedArena, "dist"), { recursive: true });
  cpSync(resolve(process.cwd(), "package.json"), resolve(installedArena, "package.json"));
  const corePackage = JSON.parse(readFileSync(resolve(workspaceRoot, "package.json"), "utf8"));
  for (const dependency of Object.keys(corePackage.dependencies ?? {})) {
    const installedDependency = resolve(smokeRoot, "node_modules", dependency);
    mkdirSync(dirname(installedDependency), { recursive: true });
    symlinkSync(resolve(workspaceRoot, "node_modules", dependency), installedDependency, "dir");
  }

  const publicImport = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    "import { createArenaRuntimeExtensionRegistry } from '@ax-arena/benchmark'; " +
      "const registry = createArenaRuntimeExtensionRegistry(); " +
      "if (registry.inspect().length !== 0) process.exit(1);",
  ], {
    cwd: smokeRoot,
    encoding: "utf8",
  });
  if (publicImport.error || publicImport.status !== 0) {
    throw new Error(publicImport.error?.message || publicImport.stderr || "built arena package could not import public ax-eval");
  }
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}

console.log(`Verified ${files.size} arena package files (${report.filename}).`);
