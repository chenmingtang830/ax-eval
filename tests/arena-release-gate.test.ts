import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertArenaMappingsExecutable,
  assertPublicArenaPackage,
  localArenaReleaseIssues,
} from "../.github/arena-release-gate-lib.mjs";

describe("arena release gate", () => {
  it("blocks ax-eval publication while the arena package is private", () => {
    expect(() => execFileSync(process.execPath, [resolve(".github/verify-arena-release-gate.mjs")], {
      cwd: resolve("."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })).toThrow(/release blocked until the arena compatibility package is available/);
  });

  it("requires every arena-owned alias to switch before starting the compatibility clock", () => {
    const issues = localArenaReleaseIssues(
      { name: "ax-eval", version: "1.2.3" },
      { name: "@ax-arena/benchmark", version: "1.2.3", private: false, dependencies: { "ax-eval": "1.2.3" } },
      { "resolve-vendor": "resolve-vendor" },
    );
    expect(issues.join("\n")).toContain("arena aliases have not all switched to delegation");
    expect(issues.join("\n")).toContain("daeb-production-rerun");
  });

  it("requires an anonymous matching public npm manifest", async () => {
    const arena = { name: "@ax-arena/benchmark", version: "1.2.3" };
    const okFetch = async () => new Response(JSON.stringify({
      ...arena,
      dependencies: { "ax-eval": "1.2.3" },
      dist: { tarball: "https://registry.npmjs.org/package.tgz", integrity: "sha512-test" },
    }), { status: 200 });
    await expect(assertPublicArenaPackage(arena, "ax-eval", "1.2.3", "sha512-test", okFetch as typeof fetch))
      .resolves.toBeUndefined();
    const privateFetch = async () => new Response("not found", { status: 404 });
    await expect(assertPublicArenaPackage(arena, "ax-eval", "1.2.3", "sha512-test", privateFetch as typeof fetch)).rejects
      .toThrow(/not anonymously available/);
    const staleFetch = async () => new Response(JSON.stringify({
      ...arena,
      dependencies: { "ax-eval": "1.2.2" },
      dist: { tarball: "https://registry.npmjs.org/package.tgz", integrity: "sha512-stale" },
    }), { status: 200 });
    await expect(assertPublicArenaPackage(arena, "ax-eval", "1.2.3", "sha512-test", staleFetch as typeof fetch)).rejects
      .toThrow(/does not match/);
  });

  it("smokes every explicit mapping target", () => {
    const invoked: string[] = [];
    assertArenaMappingsExecutable({ old: "new", alias: "new", other: "second" }, (target) => {
      invoked.push(target);
      return 0;
    });
    expect(invoked).toEqual(["new", "second"]);
    expect(() => assertArenaMappingsExecutable({ broken: "missing" }, () => 1)).toThrow(/not executable/);
  });
});
