import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageV22CliProfile } from "../src/runtime/v22-cli-profile.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ax-v22-cli-profile-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("V2.2 controller CLI profile", () => {
  it("stages a JSON profile only inside the isolated home and returns redactions", () => {
    const root = tempRoot();
    const source = join(root, "source.json");
    const home = join(root, "home");
    writeFileSync(source, JSON.stringify({ token: "test-session-secret", nested: { refresh: "test-refresh-secret" } }));
    const staged = stageV22CliProfile({
      sourcePath: source,
      isolatedHome: home,
      relativeDestination: ".nile/credentials.json",
    });
    expect(staged.destination).toBe(join(home, ".nile", "credentials.json"));
    expect(readFileSync(staged.destination, "utf8")).toContain("test-session-secret");
    expect(staged.redactionValues).toEqual(expect.arrayContaining(["test-session-secret", "test-refresh-secret"]));
  });

  it("rejects a destination that could escape the isolated home", () => {
    const root = tempRoot();
    const source = join(root, "source.json");
    writeFileSync(source, "{}");
    expect(() => stageV22CliProfile({
      sourcePath: source,
      isolatedHome: join(root, "home"),
      relativeDestination: "../credentials.json",
    })).toThrow("invalid controller CLI profile destination");
  });
});
