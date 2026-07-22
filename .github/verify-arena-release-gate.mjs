import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const arena = JSON.parse(readFileSync(resolve("ax-arena/benchmark/package.json"), "utf8"));
const coreRange = arena.dependencies?.[root.name];
const issues = [];
if (arena.private !== false) issues.push(`${arena.name} is still private`);
if (coreRange !== root.version) issues.push(`${arena.name} must pin ${root.name}@${root.version}`);
if (issues.length) {
  throw new Error(
    `release blocked until the arena compatibility package is available: ${issues.join("; ")}. `
    + "Do not start the one-minor alias clock from an ax-eval-only release.",
  );
}
