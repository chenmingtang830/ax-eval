import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadPack } from "../src/config.js";
import { checkApproval } from "../src/generate/review.js";
import { loadCapabilityExtract } from "../src/generate/capability-extract.js";
import { loadOracleExtract } from "../src/generate/task-extract.js";
import { loadSurfaceExtract } from "../src/generate/surface-extract.js";
import {
  ConceptUniverseSchema,
  loadCoverageMatrix,
  loadSelectionLedger,
} from "../src/generate/methodology.js";

const ROOT = resolve(import.meta.dirname, "..");
const SUITE_PATH = "ax-arena/benchmark/daeb/v1/suite.yaml";
const VERSION_DIR = resolve(ROOT, "ax-arena/benchmark/daeb/v1");
const FROZEN_PACK_HASHES: Record<string, { approval: string; pack: string }> = {
  cockroachdb: {
    approval: "9c4980cb7b34a08dd980bd23df27baa02acc0573186c68b6128801b177f64910",
    pack: "1401aab8fa4a75e3ed68819e768d50286341c8fa2baae32dbd3152cf7ebc8a0b",
  },
  insforge: {
    approval: "10cd4c4f2292a5155ba0ec91264dc5bff8f29126c8bf4539863fce5c4caea501",
    pack: "88b8549cc89b14f6f03f3d7d44c80d7234509faacce36729a7567893f0884502",
  },
  neon: {
    approval: "cb18ed41893e94988dc63e9a61d50dd0ff723ff9b19a92b15119c3bdd69d824d",
    pack: "8d21d813f05bf92109c70690d42f4f7e839fa16e509c547caea3cfee5f707c2d",
  },
  nile: {
    approval: "986f70f2d43b9e71d9f1dc8f904601afcac10449b2a68dce14465e7e64ee339b",
    pack: "e592542ffaecbd62e53db65dce2bcfb821a08a3c28e2c32eb1a1f8a2586a0c2c",
  },
  supabase: {
    approval: "f613b2f164f761dc635550e4c97d07cc109591227b6d2f8ff35648f55441b3a6",
    pack: "964c54a1d4dd76ea6ea905a38b38e1704f03ffc8d665d6c533d4c28a52e159a4",
  },
  turso: {
    approval: "7555190d29dd8ea09175c9c30523487f551dfe59cc6c9d08c516030e991592c4",
    pack: "190165bca064a0a583972146a6388ea0f0ea9cee252745996ce64e30c0651308",
  },
};

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function findSymlinks(path: string): string[] {
  const symlinks: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (lstatSync(child).isSymbolicLink()) symlinks.push(child);
    else if (entry.isDirectory()) symlinks.push(...findSymlinks(child));
  }
  return symlinks;
}

describe("frozen DAEB artifacts", () => {
  it("loads the canonical concept, coverage, and selection contracts", () => {
    const concept = ConceptUniverseSchema.parse(parseYaml(
      readFileSync(resolve(VERSION_DIR, "suite.concept-universe.yaml"), "utf8"),
    ));
    expect(concept.schema).toBe("ax.concept-universe/v1");
    expect(loadCoverageMatrix(ROOT, SUITE_PATH)?.schema).toBe("ax.coverage-matrix/v1");
    expect(loadSelectionLedger(ROOT, SUITE_PATH)?.schema).toBe("ax.selection-ledger/v1");
  });

  it("loads every frozen vendor extract and preserves every approval", () => {
    const vendors = readdirSync(resolve(VERSION_DIR, "packs"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(vendors.length).toBeGreaterThan(0);
    for (const vendor of vendors) {
      expect(loadCapabilityExtract(ROOT, vendor)).not.toBeNull();
      expect(loadSurfaceExtract(ROOT, vendor)).not.toBeNull();
      expect(loadOracleExtract(ROOT, vendor, "daeb")).not.toBeNull();
      const packPath = resolve(VERSION_DIR, "packs", vendor, "pack.yaml");
      expect(checkApproval(loadPack(packPath), packPath), vendor).toEqual({ ok: true });
      expect(sha256(packPath), `${vendor} pack bytes`).toBe(FROZEN_PACK_HASHES[vendor]?.pack);
      expect(sha256(resolve(VERSION_DIR, "packs", vendor, "pack.approval.json")), `${vendor} approval bytes`)
        .toBe(FROZEN_PACK_HASHES[vendor]?.approval);
    }
  });

  it("stores the canonical tree only in the arena workspace without symlinks", () => {
    expect(existsSync(resolve(ROOT, "benchmarks", "daeb"))).toBe(false);
    expect(findSymlinks(resolve(ROOT, "ax-arena", "benchmark", "daeb"))).toEqual([]);
  });
});
