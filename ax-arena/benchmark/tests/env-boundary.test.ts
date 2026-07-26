import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ARENA_ROOT = resolve(REPOSITORY_ROOT, "ax-arena", "benchmark");

function assignments(source: string): Map<string, string> {
  return new Map([...source.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((match) => [match[1]!, match[2]!]));
}

function credentialEnvironmentNames(value: unknown, names = new Set<string>(), parentKey = ""): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if ((parentKey === "env_aliases" || parentKey.endsWith("_env_aliases"))
        && typeof entry === "string" && /^[A-Z][A-Z0-9_]*$/.test(entry)) names.add(entry);
      credentialEnvironmentNames(entry, names, parentKey);
    }
    return names;
  }
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) names.add(match[1]!);
    return names;
  }
  if (!value || typeof value !== "object") return names;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "env" || key.endsWith("_env"))
      && typeof entry === "string" && /^[A-Z][A-Z0-9_]*$/.test(entry)) names.add(entry);
    credentialEnvironmentNames(entry, names, key);
  }
  return names;
}

describe("environment template ownership", () => {
  it("keeps cohort credentials in arena and runtime identity only in the committed lock", () => {
    const rootTemplate = assignments(readFileSync(resolve(REPOSITORY_ROOT, ".env.example"), "utf8"));
    const arenaTemplate = assignments(readFileSync(resolve(ARENA_ROOT, ".env.example"), "utf8"));
    const workflow = readFileSync(resolve(REPOSITORY_ROOT, ".github", "workflows", "trusted-sandbox-records.yml"), "utf8");
    const packsRoot = resolve(ARENA_ROOT, "daeb", "v1", "packs");
    const packCredentialNames = readdirSync(packsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const source = readFileSync(resolve(packsRoot, entry.name, "pack.yaml"), "utf8");
        return [...credentialEnvironmentNames(parse(source))];
      });
    const sharedHarnessNames = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    const workflowCredentialNames = [...workflow.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)]
      .map((match) => match[1]!)
      .filter((name) => !sharedHarnessNames.has(name));
    const workflowCredentialSet = new Set(workflowCredentialNames);
    const expectedArenaNames = [...new Set([...packCredentialNames, ...workflowCredentialNames])].sort();

    expect([...arenaTemplate.keys()].sort()).toEqual(expectedArenaNames);
    expect([...arenaTemplate.values()]).toEqual(expectedArenaNames.map(() => ""));
    for (const name of packCredentialNames) expect(workflowCredentialSet.has(name)).toBe(true);
    for (const name of expectedArenaNames) expect(rootTemplate.has(name)).toBe(false);
    for (const name of sharedHarnessNames) expect(rootTemplate.has(name)).toBe(true);
    for (const obsoleteOverride of [
      "AX_ARENA_TURSO_INSTALL_ROOT",
      "AX_ARENA_TURSO_CLI_VERSION",
      "AX_ARENA_TURSO_CLI_SHA256",
      "AX_ARENA_CODEX_VERSION",
      "AX_ARENA_CLAUDE_VERSION",
    ]) {
      expect(rootTemplate.has(obsoleteOverride)).toBe(false);
      expect(arenaTemplate.has(obsoleteOverride)).toBe(false);
      expect(workflow).not.toMatch(new RegExp(`secrets\\.${obsoleteOverride}\\b`));
    }
  });
});
