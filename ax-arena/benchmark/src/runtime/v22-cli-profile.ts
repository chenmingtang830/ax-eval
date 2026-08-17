import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

function collectStringLeaves(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(collectStringLeaves);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectStringLeaves);
}

function validateRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`invalid controller CLI profile destination: ${value}`);
  }
  return normalized;
}

/**
 * Stages the smallest possible authenticated CLI profile into an already
 * isolated harness home. The source profile never becomes part of an artifact,
 * and every string leaf is returned for transcript redaction.
 */
export function stageV22CliProfile(options: {
  sourcePath: string;
  isolatedHome: string;
  relativeDestination: string;
}): { destination: string; redactionValues: string[] } {
  const source = resolve(options.sourcePath);
  if (!existsSync(source)) throw new Error(`missing controller CLI profile: ${source}`);
  const destination = resolve(options.isolatedHome, validateRelativePath(options.relativeDestination));
  const home = resolve(options.isolatedHome);
  if (destination !== home && !destination.startsWith(`${home}${sep}`)) {
    throw new Error("controller CLI profile destination escapes isolated home");
  }
  const body = readFileSync(source, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error(`controller CLI profile is not JSON: ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, body, { mode: 0o600 });
  chmodSync(destination, 0o600);
  return {
    destination,
    redactionValues: [...new Set(collectStringLeaves(parsed))],
  };
}
