import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

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
const missing = required.filter((path) => !files.has(path));
const forbidden = [...files].filter((path) => path.startsWith("src/") || path.startsWith("tests/") || path.startsWith("scripts/"));
if (missing.length || forbidden.length) {
  throw new Error([
    missing.length ? `missing required arena package files: ${missing.join(", ")}` : "",
    forbidden.length ? `forbidden arena package files: ${forbidden.join(", ")}` : "",
  ].filter(Boolean).join("; "));
}

const installedBin = spawnSync(resolve(process.cwd(), "..", "..", "node_modules", ".bin", "ax-arena"), ["benchmark", "--help"], {
  encoding: "utf8",
});
if (installedBin.error || installedBin.status !== 0 || !installedBin.stdout.includes("usage: ax-arena benchmark")) {
  throw new Error(installedBin.error?.message || installedBin.stderr || "installed ax-arena binary did not print benchmark help");
}

console.log(`Verified ${files.size} arena package files (${report.filename}).`);
