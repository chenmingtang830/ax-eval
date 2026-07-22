import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  assertArenaMappingsExecutable,
  assertPublicArenaPackage,
  localArenaReleaseIssues,
} from "./arena-release-gate-lib.mjs";

const root = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const arena = JSON.parse(readFileSync(resolve("ax-arena/benchmark/package.json"), "utf8"));
const mappings = JSON.parse(readFileSync(resolve("src/arena-compatibility-map.json"), "utf8"));
const issues = localArenaReleaseIssues(root, arena, mappings);
if (issues.length) {
  throw new Error(
    `release blocked until the arena compatibility package is available: ${issues.join("; ")}. `
    + "Do not start the one-minor alias clock from an ax-eval-only release.",
  );
}
const arenaCli = resolve("ax-arena/benchmark/dist/cli.js");
assertArenaMappingsExecutable(mappings, (target) => {
  const result = execFileSync(process.execPath, [arenaCli, "benchmark", target, "--help"], {
    cwd: resolve("."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return typeof result === "string" ? 0 : 1;
});
const packOutput = JSON.parse(execFileSync("npm", [
  "--cache", resolve(".npm-cache"), "pack", "--dry-run", "--json", "--workspace", arena.name,
], {
  cwd: resolve("."),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}));
const localIntegrity = packOutput?.[0]?.integrity;
if (typeof localIntegrity !== "string") throw new Error("could not compute the local arena package integrity");
await assertPublicArenaPackage(arena, root.name, root.version, localIntegrity);
