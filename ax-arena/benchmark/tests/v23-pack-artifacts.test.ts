import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadPack } from "ax-eval";
import { V22NativeJourneySchema } from "../src/runtime/v22-native-journey.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const V23 = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3");
const vendors = ["cockroachdb", "insforge", "neon", "nile", "supabase", "turso"];
const atomicTasks = [
  "db-T17-cli-session-discovery", "db-T21-cli-principal-continuity", "db-T18-constraint-preservation",
  "db-T19-transactional-record-recovery", "db-T20-aggregate-query", "db-T22-negative-query-verification",
];
const scopeEnvByVendor: Record<string, string[]> = {
  cockroachdb: ["COCKROACH_CLUSTER_ID", "COCKROACH_DATABASE"],
  insforge: ["INSFORGE_PROJECT_URL"],
  neon: ["NEON_PROJECT_ID", "NEON_BRANCH_ID"],
  nile: ["NILE_WORKSPACE", "NILE_DB"],
  supabase: ["SUPABASE_PROJECT_REF", "SUPABASE_URL"],
  turso: ["TURSO_ORG", "TURSO_SANDBOX_DATABASE", "TURSO_DATABASE_URL"],
};
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("V2.3 vendor-experience pack artifacts", () => {
  it("derives only the frozen atomic task set with hashes bound in the manifest", () => {
    const manifest = JSON.parse(readFileSync(resolve(V23, "packs/derived-pack-manifest.json"), "utf8")) as {
      suite: { sha256: string }; vendors: Record<string, { pack: string; pack_sha256: string; task_ids: string[] }>;
    };
    const suitePath = resolve(V23, "vendor-experience-suite.yaml");
    expect(manifest.suite.sha256).toBe(hash(suitePath));
    expect(Object.keys(manifest.vendors).sort()).toEqual(vendors);
    for (const vendor of vendors) {
      const item = manifest.vendors[vendor]!;
      const packPath = resolve(ROOT, item.pack);
      const pack = loadPack(packPath);
      expect(item.pack_sha256).toBe(hash(packPath));
      expect(item.task_ids).toEqual(atomicTasks);
      expect(pack.standard_set_version).toBe("daeb-2-3-cli-vendor-experience-v1");
      expect(pack.tasks.map((task) => task.id)).toEqual(atomicTasks);
      expect(pack.sandbox_scope.map((scope) => scope.env)).toEqual(scopeEnvByVendor[vendor]);
    }
  });

  it("binds every provider-pinned J01 contract to the V2.3 pack root", () => {
    const manifest = JSON.parse(readFileSync(resolve(V23, "contracts/native-contract-manifest.json"), "utf8")) as {
      suite: { sha256: string }; contracts: Record<string, { contract: string; contract_sha256: string }>;
    };
    expect(manifest.suite.sha256).toBe(hash(resolve(V23, "vendor-experience-suite.yaml")));
    expect(Object.keys(manifest.contracts).sort()).toEqual(["gemini-3.7-flash.yaml", "kimi-k3.yaml", "qwen-3.8-27b.yaml"]);
    for (const entry of Object.values(manifest.contracts)) {
      const contractPath = resolve(ROOT, entry.contract);
      expect(entry.contract_sha256).toBe(hash(contractPath));
      const contract = V22NativeJourneySchema.parse(parseYaml(readFileSync(contractPath, "utf8")));
      for (const [vendor, config] of Object.entries(contract.vendors)) {
        expect(config.base_pack).toBe(`ax-arena/benchmark/axarena-database/v2-3/packs/${vendor}/pack.yaml`);
      }
    }
  });
});
