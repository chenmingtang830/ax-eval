import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotenv, loadPack } from "../src/config.js";

const PACK = resolve(dirname(fileURLToPath(import.meta.url)), "..", "targets", "asana", "pack.yaml");

describe("config", () => {
  it("loads and validates the asana pack", () => {
    const pack = loadPack(PACK);
    expect(pack.name).toBe("asana");
    expect(pack.tasks.length).toBe(8);
    expect(pack.tasks[0]!.oracles.length).toBeGreaterThan(0);
  });

  describe("loadDotenv", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "axeval-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("a missing file is fine", () => {
      expect(loadDotenv(join(dir, "nope.env"))).toEqual({});
    });

    it("parses KEY=VALUE, comments, and quotes", () => {
      const p = join(dir, ".env");
      const { writeFileSync } = require("node:fs");
      writeFileSync(p, '# comment\nFOO=bar\nQUOTED="baz"\n\nNOEQUALS\n');
      delete process.env.FOO;
      delete process.env.QUOTED;
      const loaded = loadDotenv(p);
      expect(loaded).toEqual({ FOO: "bar", QUOTED: "baz" });
      expect(process.env.FOO).toBe("bar");
    });
  });
});
