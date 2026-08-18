#!/usr/bin/env node
/**
 * Freeze the internal DAEB V2.4 result into the deterministic, vendor-first
 * AXArena Database 1.0.0 public release.
 * data package. Final audit artifacts are retained after workstation paths are
 * replaced with stable workspace URIs. The package binds every source file and
 * every exported file with SHA-256.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import YAML from "yaml";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const INPUTS = resolve(ROOT, process.env.DAEB_V24_SUMMARY_MANIFEST
  ?? "ax-arena/benchmark/axarena-database/v2-4/publication-inputs.json");
const SUMMARY = resolve(ROOT, process.env.DAEB_V24_SUMMARY_ROOT
  ?? "results/v24-vendor-publication-summary-r3", "summary.json");
const EVIDENCE_ROOT = resolve(process.env.DAEB_V24_EVIDENCE_ROOT ?? ROOT);
const SUITE = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-4/vendor-experience-suite.yaml");
const LEDGER = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-4/model-admission-ledger.json");
const PUBLICATION_PARENT = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-4");
const OUTPUT = resolve(ROOT, process.env.DAEB_V24_PUBLICATION_OUTPUT
  ?? "ax-arena/benchmark/axarena-database/v2-4/publication");
const WORKSPACE_PREFIX = `${ROOT}${sep}`;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type FileEntry = { path: string; bytes: number; sha256: string };

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sanitize(value: Json): Json {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  if (typeof value !== "string") return value;
  if (value.startsWith(WORKSPACE_PREFIX)) return `workspace://ax-eval/${value.slice(WORKSPACE_PREFIX.length)}`;
  return value
    .replaceAll(WORKSPACE_PREFIX, "workspace://ax-eval/")
    .replace(/\/Users\/[^/]+\/ax-eval\//g, "workspace://ax-eval/")
    .replace(/\/private\/var\/folders\/[^\s\"']+/g, "local-temp://redacted")
    .replace(/\/tmp\/[^\s\"']+/g, "local-temp://redacted");
}

function files(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) found.push(path);
      else throw new Error(`unsupported evidence entry: ${path}`);
    }
  };
  visit(root);
  return found;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, canonical(value), { mode: 0o644 });
}

function copySanitized(source: string, destination: string): void {
  const content = readFileSync(source, "utf8");
  const lines = source.endsWith(".jsonl") ? content.split(/\r?\n/).filter(Boolean) : [content];
  const output = lines.map((line) => canonical(sanitize(JSON.parse(line) as Json)).trimEnd()).join("\n") + "\n";
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  writeFileSync(destination, output, { mode: 0o644 });
}

function inventory(root: string): FileEntry[] {
  return files(root).map((path) => {
    const bytes = readFileSync(path);
    return { path: relative(root, path).split(sep).join("/"), bytes: bytes.length, sha256: sha(bytes) };
  });
}

export function build(): void {
  const inputs = JSON.parse(readFileSync(INPUTS, "utf8"));
  const summary = JSON.parse(readFileSync(SUMMARY, "utf8"));
  const suite = YAML.parse(readFileSync(SUITE, "utf8"));
  const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
  if (inputs.schema !== "ax.daeb-v2-4-publication-inputs/v1" || inputs.formal !== false) throw new Error("invalid V2.4 inputs");
  if (summary.schema !== "ax.daeb-v2-4-vendor-first-summary/v1" || summary.primary_unit !== "vendor") throw new Error("invalid V2.4 summary");
  const declared = new Set(suite.model_strata.map((item: any) => `${item.model}\0${item.provider}`));
  const admitted = new Set(inputs.models.map((item: any) => `${item.model}\0${item.provider}`));
  if (declared.size !== admitted.size || [...declared].some((item) => !admitted.has(item))) {
    throw new Error("suite model_strata do not match publication inputs");
  }
  if (summary.sample.atomic_cells !== 420 || summary.sample.j01_sessions !== 70) throw new Error("unexpected V2.4 denominator");
  for (const status of ["invalid-infra", "invalid-route", "invalid-evidence"]) {
    if ((summary.sample.atomic_status_counts[status] ?? 0) !== 0 || (summary.sample.j01_status_counts[status] ?? 0) !== 0) {
      throw new Error(`summary admits ${status}`);
    }
  }
  if (dirname(OUTPUT) !== PUBLICATION_PARENT || OUTPUT === PUBLICATION_PARENT) {
    throw new Error("V2.4 publication output must be a direct child of the V2.4 directory");
  }
  if (existsSync(OUTPUT)) rmSync(OUTPUT, { recursive: true });
  mkdirSync(OUTPUT, { recursive: true, mode: 0o755 });

  const evidenceSources: any[] = [];
  for (const model of inputs.models) for (const trial of model.trials) {
    for (const kind of ["atomic", "j01"] as const) {
      const sourceRoot = resolve(EVIDENCE_ROOT, trial[`${kind}_audit_root`]);
      if (!statSync(sourceRoot).isDirectory()) throw new Error(`missing audit root: ${sourceRoot}`);
      const sourceFiles = inventory(sourceRoot);
      const archiveId = `${model.model.replaceAll("/", "_")}--${model.provider}--t${trial.trial}--${kind}`;
      const exportedRoot = resolve(OUTPUT, "evidence", archiveId);
      for (const entry of sourceFiles) copySanitized(resolve(sourceRoot, entry.path), resolve(exportedRoot, entry.path));
      evidenceSources.push({
        archive_id: archiveId,
        model: model.model,
        provider: model.provider,
        trial: trial.trial,
        kind,
        source_root: trial[`${kind}_audit_root`],
        source_files: sourceFiles,
        source_tree_sha256: sha(canonical(sourceFiles)),
      });
    }
  }

  writeJson(resolve(OUTPUT, "publication.json"), {
    schema: "ax.daeb-v2-4-publication/v1",
    release: "1.0.0",
    display_name: "AXArena Database 1.0.0",
    protocol: { name: "DAEB", version: "2.4" },
    formal: false,
    status: "public-diagnostic-release",
    primary_unit: "vendor",
    sample: summary.sample,
    claim_boundary: summary.interpretation_boundary.map((item: string) =>
      item.replace("V2.4 diagnostics", "DAEB V2.4 protocol diagnostics")),
  });
  writeJson(resolve(OUTPUT, "vendor-summary.json"), {
    schema: "ax.daeb-v2-4-vendor-summary/v1", primary_unit: "vendor", row_order: summary.row_order, rows: summary.rows,
  });
  writeJson(resolve(OUTPUT, "model-slices.json"), {
    schema: "ax.daeb-v2-4-model-slices/v1", role: "supplementary", rows: summary.model_slice_rows,
  });
  writeJson(resolve(OUTPUT, "tasks.json"), {
    schema: "ax.daeb-v2-4-tasks/v1", surface: suite.surface, contract: suite.task_contract, tasks: suite.tasks,
  });
  writeJson(resolve(OUTPUT, "exclusions.json"), sanitize(ledger));
  writeJson(resolve(OUTPUT, "methodology.json"), sanitize({
    schema: suite.schema,
    name: suite.name,
    version: suite.version,
    formal: suite.formal,
    primary_unit: suite.primary_unit,
    surface: suite.surface,
    vendors: suite.vendors,
    model_strata: suite.model_strata,
    trial_count: suite.trial_count,
    aggregation: suite.aggregation,
    publication_boundary: suite.publication_boundary,
  }));
  writeJson(resolve(OUTPUT, "evidence-index.json"), {
    schema: "ax.daeb-v2-4-evidence-index/v1",
    source_evidence_scope: "final independent audit artifacts only",
    path_policy: "workstation paths are replaced with workspace://ax-eval URIs in exported evidence",
    archives: evidenceSources,
  });
  const embeddedEvidence = inventory(resolve(OUTPUT, "evidence"));
  writeJson(resolve(OUTPUT, "archive-manifest.json"), {
    schema: "ax.daeb-v2-4-archive-manifest/v1",
    release: "1.0.0",
    protocol: { name: "DAEB", version: "2.4" },
    public_evidence: {
      disposition: "embedded-in-repository",
      root: "evidence/",
      archive_count: evidenceSources.length,
      file_count: embeddedEvidence.length,
      bytes: embeddedEvidence.reduce((total, entry) => total + entry.bytes, 0),
      tree_sha256: sha(canonical(embeddedEvidence)),
    },
    external_archives: [],
    external_archive_required: false,
    rationale: "The sanitized final-audit evidence is small enough to ship directly in the release, so no external binary archive or mutable download dependency is required.",
    raw_local_evidence: {
      disposition: "excluded-from-publication",
      locator_disclosed: false,
      reason: "The raw local tree mixes admitted runs with preflight material and may contain workstation or credential-shaped metadata; the sanitized final-audit package is the public replay boundary.",
    },
  });
  writeFileSync(resolve(OUTPUT, "README.md"), `# AXArena Database 1.0.0 frozen publication data

This directory is the deterministic, vendor-first export for the first public
AXArena Database release. It is built from the frozen internal DAEB V2.4
protocol. The primary outcome is J01 end-to-end success. Atomic tasks are
supporting diagnostics and model/trial rows are supplementary slices.

- \`vendor-summary.json\`: vendor rows with outcome, discovery, efficiency, and cost columns.
- \`model-slices.json\`: supplementary model-level J01 view.
- \`tasks.json\`: the frozen atomic and J01 task contract.
- \`evidence-index.json\`: source hashes for all 28 final-audit inputs.
- \`archive-manifest.json\`: explicit embedded/external/raw archive disposition.
- \`evidence/\`: sanitized final audits, observations, and reconciliation ledgers.
- \`exclusions.json\`: retained invalid/diagnostic runs and their admission decisions.
- \`checksums.json\`: SHA-256 inventory for every other file in this directory.

The release is diagnostic: seven model/provider slices, two trials, five core
database vendors, 420 atomic cells, and 70 J01 journeys. It is not a universal
product leaderboard. Workstation paths in evidence are replaced with
\`workspace://ax-eval/\` URIs. Transient upstream failures are preserved as
observations; the export does not claim those failures will recur on demand.
`, { mode: 0o644 });
  const exported = inventory(OUTPUT).filter((entry) => entry.path !== "checksums.json");
  writeJson(resolve(OUTPUT, "checksums.json"), {
    schema: "ax.daeb-v2-4-checksums/v1",
    algorithm: "sha256",
    files: exported,
    tree_sha256: sha(canonical(exported)),
  });
  console.log(JSON.stringify({ output: relative(ROOT, OUTPUT), files: exported.length + 1, evidence_archives: evidenceSources.length }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) build();
