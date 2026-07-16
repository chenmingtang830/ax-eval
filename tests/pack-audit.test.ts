import { describe, expect, it } from "vitest";
import { composePack } from "../src/generate/compose-pack.js";
import type { PackComposeConfig } from "../src/generate/pack-compose-config.js";
import { auditComposedPack, type ComposedPackAuditInput } from "../src/generate/pack-audit.js";
import type { Suite } from "../src/generate/suite.js";
import type { SurfaceExtractResult } from "../src/generate/surface-extract.js";
import type { TaskExtractResult } from "../src/generate/task-extract.js";
import type { ResolveResult } from "../src/generate/vendor-resolve.js";

const vendor: ResolveResult = {
  vendor: "Acme",
  category: "database",
  slug: "acme",
  discovered_at: "2026-07-16T00:00:00.000Z",
  resolver: { method: "grounded-generator", prompt_version: "test" },
  site_url: "https://acme.example",
  docs_url: "https://docs.acme.example",
};

const suite: Suite = {
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
    allowed_surfaces: ["api", "cli"],
    na_examples: [],
  }],
};

const surfaces: SurfaceExtractResult = {
  vendor: "Acme",
  slug: "acme",
  extracted_at: "2026-07-16T00:00:00.000Z",
  cli: {
    bin: "acme",
    install: "npm install -g acme-cli",
    docs_url: "https://docs.acme.example/cli",
    auth: { kind: "inherit" },
  },
  sdk: null,
  mcp: null,
};

const tasks: TaskExtractResult = {
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
    allowed_surfaces: ["api", "cli"],
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

const config: PackComposeConfig = {
  base_url: "https://api.acme.example",
  api_style: "rest",
  auth: { type: "none", env: "", env_aliases: [], verify_env_aliases: [] },
  sandbox_scope: [],
  headers: {},
};

function input(overrides: Partial<ComposedPackAuditInput> = {}): ComposedPackAuditInput {
  const pack = composePack(vendor, suite, surfaces, tasks, config, {
    now: () => new Date("2026-07-16T01:02:03.000Z"),
  });
  return { pack, vendor, suite, surfaces, tasks, config, ...overrides };
}

describe("auditComposedPack", () => {
  it("accepts an unchanged composed pack", () => {
    expect(auditComposedPack(input())).toEqual([]);
  });

  it("treats omitted undefined fields as equivalent persisted content", () => {
    const auditInput = input();
    auditInput.pack = JSON.parse(JSON.stringify(auditInput.pack));
    expect(auditComposedPack(auditInput)).toEqual([]);
  });

  it("classifies identity and configuration drift without printing values", () => {
    const auditInput = input();
    auditInput.pack = {
      ...auditInput.pack,
      name: "other",
      standard_set_version: "other-v2",
      base_url: "https://changed.example",
    };
    expect(auditComposedPack(auditInput)).toEqual([
      expect.objectContaining({ code: "pack_identity_drift", message: expect.stringContaining("name, standard_set_version") }),
      expect.objectContaining({ code: "pack_config_drift", message: expect.stringContaining("base_url") }),
    ]);
  });

  it("treats discovery contract changes as configuration drift", () => {
    const discoveryConfig: PackComposeConfig = {
      ...config,
      discovery: {
        product: "Acme",
        goal: "Create a record",
        official_domains: ["docs.acme.example"],
        canonical_endpoint: "POST /records",
        deprecated_markers: [],
        auth_scheme: "Bearer token",
      },
    };
    const auditInput = input({
      config: discoveryConfig,
      pack: {
        ...composePack(vendor, suite, surfaces, tasks, discoveryConfig),
        discovery: { ...discoveryConfig.discovery!, canonical_endpoint: "POST /v2/records" },
      },
    });
    expect(auditComposedPack(auditInput)).toEqual([
      expect.objectContaining({ code: "pack_config_drift", message: expect.stringContaining("discovery") }),
    ]);
  });

  it("reports surface and provenance drift independently", () => {
    const auditInput = input();
    auditInput.pack = {
      ...auditInput.pack,
      surfaces: {
        ...auditInput.pack.surfaces,
        cli: { ...auditInput.pack.surfaces!.cli!, bin: "changed" },
      },
      generator: { ...auditInput.pack.generator!, model: "other" },
    };
    expect(auditComposedPack(auditInput).map((finding) => finding.code)).toEqual([
      "pack_surface_drift",
      "pack_provenance_drift",
    ]);
  });

  it("distinguishes task membership from task content drift", () => {
    const missingTask = input();
    missingTask.pack = { ...missingTask.pack, tasks: [] };
    expect(auditComposedPack(missingTask).map((finding) => finding.code)).toEqual(["pack_task_set_drift"]);

    const changedTask = input();
    changedTask.pack = {
      ...changedTask.pack,
      tasks: changedTask.pack.tasks.map((task) => ({ ...task, allowed_surfaces: ["api"] })),
    };
    expect(auditComposedPack(changedTask).map((finding) => finding.code)).toEqual(["pack_task_content_drift"]);
  });

  it("requires every sandbox scope to be bound in authoring text", () => {
    const scopedConfig: PackComposeConfig = {
      ...config,
      sandbox_scope: [{ name: "project", env: "ACME_SANDBOX_PROJECT", required: true, instructions: "Choose a sandbox project." }],
    };
    const unbound = input({
      config: scopedConfig,
      pack: composePack(vendor, suite, surfaces, tasks, scopedConfig),
    });
    expect(auditComposedPack(unbound)).toEqual([
      expect.objectContaining({ code: "sandbox_scope_unbound", message: expect.stringContaining("project") }),
    ]);

    const boundTasks: TaskExtractResult = {
      ...tasks,
      tasks: tasks.tasks.map((task) => ({ ...task, prompt: `${task.prompt} Use ACME_SANDBOX_PROJECT.` })),
    };
    const bound = input({
      tasks: boundTasks,
      config: scopedConfig,
      pack: composePack(vendor, suite, surfaces, boundTasks, scopedConfig),
    });
    expect(auditComposedPack(bound)).toEqual([]);
  });
});
