import { composePack } from "../../src/generate/compose-pack.js";
import type { PackComposeConfig } from "../../src/generate/pack-compose-config.js";
import type { Suite } from "../../src/generate/suite.js";
import type { SurfaceExtractResult } from "../../src/generate/surface-extract.js";
import type { TaskExtractResult } from "../../src/generate/task-extract.js";
import type { ResolveResult } from "../../src/generate/vendor-resolve.js";

export const packAuthoringVendor: ResolveResult = {
  vendor: "Acme",
  category: "database",
  slug: "acme",
  discovered_at: "2026-07-16T00:00:00.000Z",
  resolver: { method: "grounded-generator", prompt_version: "test" },
  site_url: "https://acme.example",
  docs_url: "https://docs.acme.example",
};

export const packAuthoringSuite: Suite = {
  name: "database-core",
  version: 1,
  category: "database",
  tasks: [{
    id: "create-record",
    title: "Create a record",
    difficulty: "L1",
    skill: "records",
    intent: "Create one namespaced record.",
    oracle_hint: "Read the record back.",
    allowed_surfaces: ["api"],
    na_examples: [],
  }],
};

export const packAuthoringSurfaces: SurfaceExtractResult = {
  vendor: "Acme",
  slug: "acme",
  extracted_at: "2026-07-16T00:00:00.000Z",
  cli: null,
  sdk: null,
  mcp: null,
};

export const packAuthoringTasks: TaskExtractResult = {
  vendor: "Acme",
  slug: "acme",
  suite_name: "database-core",
  suite_version: 1,
  extracted_at: "2026-07-16T00:00:00.000Z",
  extractor: "test",
  tasks: [{
    id: "create-record",
    title: "Create a record",
    difficulty: "L1",
    prompt: "Create ax_record_{ns}.",
    allowed_surfaces: ["api"],
    na: false,
    na_reason: null,
    support_evidence: [{ doc_url: "https://docs.acme.example/records", quote: "Create records." }],
    oracles: [{
      type: "roundtrip",
      readMethod: "GET",
      readPathTemplate: "/records/{gid}",
      assertField: "name",
      expected: "ax_record_{ns}",
      description: "Record exists.",
    }],
  }],
};

export const packAuthoringConfig: PackComposeConfig = {
  base_url: "https://api.acme.example",
  api_style: "rest",
  auth: { type: "none", env: "", env_aliases: [], verify_env_aliases: [] },
  sandbox_scope: [],
  headers: {},
};

export function createPackAuthoringArtifacts(options: {
  taskExtract?: TaskExtractResult;
  packBaseUrl?: string;
} = {}) {
  const tasks = options.taskExtract ?? packAuthoringTasks;
  const pack = composePack(packAuthoringVendor, packAuthoringSuite, packAuthoringSurfaces, tasks, packAuthoringConfig, {
    now: () => new Date("2026-07-16T01:02:03.000Z"),
  });
  return {
    vendor: packAuthoringVendor,
    suite: packAuthoringSuite,
    surfaces: packAuthoringSurfaces,
    tasks,
    config: packAuthoringConfig,
    pack: { ...pack, base_url: options.packBaseUrl ?? pack.base_url },
  };
}
