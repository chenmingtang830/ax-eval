import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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
const SUITE_PATH = "benchmarks/daeb/v1/suite.yaml";
const VERSION_DIR = resolve(ROOT, "benchmarks/daeb/v1");

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
    }
  });
});
