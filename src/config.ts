/** Config loading: `.env` parsing and target-pack YAML loading + validation. */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { TargetPackSchema, type TargetPack } from "./schemas.js";

/**
 * Minimal `.env` loader. Missing file is fine (the keyless path). Lines are
 * KEY=VALUE; blanks and `#` comments are ignored. Values load into process.env
 * unless already set (unless `override`).
 */
export function loadDotenv(path = ".env", override = false): Record<string, string> {
  const loaded: Record<string, string> = {};
  if (!existsSync(path)) return loaded;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (!key) continue;
    loaded[key] = value;
    if (override || !(key in process.env)) process.env[key] = value;
  }
  return loaded;
}

/** Load and validate a target pack from a YAML file. */
export function loadPack(path: string): TargetPack {
  const data = parseYaml(readFileSync(path, "utf8"));
  return TargetPackSchema.parse(data);
}
