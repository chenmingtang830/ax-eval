import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AXARENA_DATABASE_V1_CONFIGURATION_PATHS,
  buildAxArenaDatabaseV1ActivationConfigurations,
  serializeActivationConfiguration,
} from "../src/controller/activation.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const configurations = buildAxArenaDatabaseV1ActivationConfigurations(root);
const write = process.argv.slice(2).includes("--write");

for (const [name, relativePath] of Object.entries(AXARENA_DATABASE_V1_CONFIGURATION_PATHS)) {
  const path = resolve(root, relativePath);
  const expected = serializeActivationConfiguration(configurations[name as keyof typeof configurations]);
  if (write) {
    writeFileSync(path, expected, { encoding: "utf8", flag: "w" });
    continue;
  }
  let actual = "";
  try {
    actual = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${relativePath} is missing; run npm run activation:write --workspace @ax-arena/benchmark`);
  }
  if (actual !== expected) {
    throw new Error(`${relativePath} is stale; run npm run activation:write --workspace @ax-arena/benchmark`);
  }
}

process.stdout.write(`${write ? "wrote" : "verified"} AXArena-Database v1 activation configurations\n`);
