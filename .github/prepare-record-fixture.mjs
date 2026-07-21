import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [baseRef, fixturePath, destination] = process.argv.slice(2);
if (!baseRef || !fixturePath || !destination) {
  throw new Error("usage: prepare-record-fixture.mjs <base-ref> <fixture-path> <destination>");
}

const target = resolve(destination);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

const listing = spawnSync("git", ["ls-tree", "-r", "--name-only", baseRef, "--", fixturePath], {
  encoding: "utf8",
});
if (listing.error || listing.status !== 0) {
  throw new Error(listing.error?.message || listing.stderr || `git ls-tree exited ${listing.status}`);
}

const files = listing.stdout.split("\n").filter(Boolean);
if (files.length === 0) {
  // The first PR that introduces the fixture has no base-side copy. Comparing
  // the candidate to itself produces an honest zero-delta bootstrap report.
  if (!existsSync(fixturePath) || readdirSync(fixturePath).length === 0) {
    throw new Error(`fixture path is empty: ${fixturePath}`);
  }
  cpSync(fixturePath, target, { recursive: true });
  console.log(`No ${fixturePath} at ${baseRef}; bootstrapped baseline from the candidate fixture.`);
  process.exit(0);
}

for (const file of files) {
  const contents = spawnSync("git", ["show", `${baseRef}:${file}`], { encoding: null });
  if (contents.error || contents.status !== 0) {
    throw new Error(contents.error?.message || contents.stderr?.toString("utf8") || `git show exited ${contents.status}`);
  }
  const relative = file.slice(fixturePath.length).replace(/^\//, "");
  const output = resolve(target, relative);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, contents.stdout);
}

console.log(`Prepared ${files.length} base fixture file(s) from ${baseRef}.`);
