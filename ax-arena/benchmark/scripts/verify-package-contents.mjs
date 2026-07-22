import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

console.log(`Verified ${files.size} arena package files (${report.filename}).`);
