import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  capabilityExtractPath,
  loadCapabilityExtract,
  loadCapabilityExtractPath,
  type CapabilityExtractResult,
} from "../src/generate/capability-extract.js";
import {
  loadSurfaceExtract,
  loadSurfaceExtractPath,
  surfaceExtractPath,
  type SurfaceExtractResult,
} from "../src/generate/surface-extract.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ax-artifact-yaml-"));
  directories.push(root);
  return root;
}

const capabilityExtract: CapabilityExtractResult = {
  vendor: "Acme",
  slug: "acme",
  category: "database",
  extracted_at: "2026-07-16T00:00:00.000Z",
  extraction_provenance: { source: "official-docs", extractor: "test" },
  capabilities: [{
    capability_name: "records",
    title: "Record operations",
    family: "data",
    description: "Create records.",
    resource_kind: "record",
    operation_kind: "create",
    surfaces_documented: ["api"],
    support_type: "native",
    evidence: [{ doc_url: "https://docs.acme.example/records", quote: "Create records." }],
  }],
};

const surfaceExtract: SurfaceExtractResult = {
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

describe("validated YAML artifact loaders", () => {
  it("loads capability extracts by explicit path and legacy root/slug", () => {
    const root = temporaryRoot();
    const path = capabilityExtractPath(root, "acme");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, yamlStringify(capabilityExtract));

    expect(loadCapabilityExtractPath(path)).toEqual(capabilityExtract);
    expect(loadCapabilityExtract(root, "acme")).toEqual(capabilityExtract);
  });

  it("loads surface extracts by explicit path and legacy root/slug", () => {
    const root = temporaryRoot();
    const path = surfaceExtractPath(root, "acme");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, yamlStringify(surfaceExtract));

    expect(loadSurfaceExtractPath(path)).toEqual(surfaceExtract);
    expect(loadSurfaceExtract(root, "acme")).toEqual(surfaceExtract);
  });

  it("returns schema output with defaults applied", () => {
    const root = temporaryRoot();
    const path = join(root, "capabilities.yaml");
    const input = {
      ...capabilityExtract,
      capabilities: capabilityExtract.capabilities.map(({ surfaces_documented: _surfaces, support_type: _support, ...capability }) => capability),
    };
    writeFileSync(path, yamlStringify(input));

    expect(loadCapabilityExtractPath(path)?.capabilities[0]).toMatchObject({
      surfaces_documented: [],
      support_type: "native",
    });
  });

  it("returns null for missing artifacts", () => {
    const root = temporaryRoot();
    expect(loadCapabilityExtractPath(join(root, "missing-capabilities.yaml"))).toBeNull();
    expect(loadSurfaceExtractPath(join(root, "missing-surfaces.yaml"))).toBeNull();
  });

  it("fails closed with schema paths for malformed artifacts", () => {
    const root = temporaryRoot();
    const path = join(root, "capabilities.yaml");
    writeFileSync(path, "vendor: Acme\nslug: acme\ncapabilities: []\n");
    expect(() => loadCapabilityExtractPath(path)).toThrow(`Invalid capability extract at ${path}`);
    expect(() => loadCapabilityExtractPath(path)).toThrow(/extracted_at|extraction_provenance|capabilities/);
  });

  it("labels malformed YAML without exposing file contents", () => {
    const root = temporaryRoot();
    const path = join(root, "surfaces.yaml");
    writeFileSync(path, "vendor: [unterminated\n");
    expect(() => loadSurfaceExtractPath(path)).toThrow(`Invalid surface extract at ${path}: malformed YAML`);
  });
});
