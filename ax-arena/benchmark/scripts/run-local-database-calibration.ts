#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runLocalDatabaseCalibration } from "../src/local-database-calibration.js";

function envFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (key && raw !== undefined) values[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

const root = resolve(process.cwd());
const runRoot = process.argv[2] ? resolve(root, process.argv[2]) : resolve(root, "results/local-database-calibration");
const exportDir = process.argv[3] ? resolve(root, process.argv[3]) : resolve(runRoot, "axarena-export");
const credentials = envFile(resolve(root, ".env"));
if (!credentials.TURSO_API_TOKEN && credentials.TURSO_ORG_API_TOKEN) credentials.TURSO_API_TOKEN = credentials.TURSO_ORG_API_TOKEN;

const manifest = await runLocalDatabaseCalibration({ root, runRoot, exportDir, credentials, budgetUsd: 50 });
console.log(JSON.stringify({ status: manifest.status, cells: manifest.cells.length, measured_cost_usd: manifest.measured_cost_usd, export: resolve(exportDir, "database-v1.json") }));
