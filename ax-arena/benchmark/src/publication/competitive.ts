import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  NORMALIZED_RESULT_SCHEMA,
  REPORT_STYLE,
  type NormalizedResult,
  type SurfaceId,
} from "ax-eval";
import { assertArenaOutputRoot } from "../controller/cell.js";
import { ArenaBatchManifestSchema, type ArenaBatchManifest } from "../controller/schemas.js";
import { loadArenaPublicationCohort } from "./export.js";

const PUBLICATION_EFFORT = "high" as const;
const SURFACE_ORDER: SurfaceId[] = ["api", "cli", "sdk", "mcp"];

export interface WriteArenaCompetitiveReportOptions {
  root: string;
  bundleDir: string;
  outPath?: string;
  generatedAt?: Date;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

function insideOrEqual(root: string, candidate: string): boolean {
  return root === candidate || inside(root, candidate);
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertNoSymlinkChain(root: string, path: string, label: string): void {
  let current = root;
  for (const segment of relative(root, path).split(/[\\/]/)) {
    current = resolve(current, segment);
    if (!existsSync(current)) return;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} cannot traverse a symlink`);
  }
}

function resolveContained(root: string, input: string, label: string): string {
  const path = resolve(root, input);
  if (!inside(root, path)) throw new Error(`${label} must resolve inside the repository root`);
  return path;
}

function assertExactIsoTimestamp(value: string, label: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be an exact UTC ISO timestamp`);
  }
}

function assertComparableCompetitiveRecords(
  batch: ArenaBatchManifest,
  records: readonly NormalizedResult[],
): void {
  if (!records.length) throw new Error("competitive requires at least one normalized record");
  if (batch.configuration.command !== "daeb-production-rerun") {
    throw new Error("competitive requires a sealed production-rerun batch");
  }
  const products = batch.configuration.packs.map((pack) => pack.vendor).sort();
  const harnesses = batch.configuration.harnesses.map((pin) => pin.harness).sort();
  if (products.length < 2) throw new Error("competitive requires at least two products");

  const keys = records.map((record) => JSON.stringify([record.product, record.harness, record.surface]));
  if (new Set(keys).size !== keys.length) {
    throw new Error("competitive records contain a duplicate product, harness, and surface cell");
  }
  const expectedKeys = batch.configuration.packs.flatMap((pack) => harnesses.flatMap((harness) =>
    pack.surfaces.map((surface) => JSON.stringify([pack.vendor, harness, surface]))));
  const actualKeys = new Set(keys);
  if (records.length !== expectedKeys.length || expectedKeys.some((key) => !actualKeys.has(key))) {
    throw new Error("competitive records must form one complete product, harness, and surface matrix");
  }

  const batchIds = new Set(records.map((record) => record.run_batch_id).filter(Boolean));
  const standardSets = new Set(records.map((record) => record.standard_set_version));
  if (batchIds.size !== 1 || !batchIds.has(batch.batch_id)
    || records.some((record) => !record.run_batch_id)) {
    throw new Error("competitive records must share the sealed batch ID");
  }
  if (standardSets.size !== 1) {
    throw new Error("competitive records must share one standard-set version");
  }

  for (const record of records) {
    const pack = batch.configuration.packs.find((candidate) => candidate.vendor === record.product);
    const pin = batch.configuration.harnesses.find((candidate) => candidate.harness === record.harness);
    const configured = batch.configuration.cells.filter((cell) => cell.vendor === record.product
      && cell.surface === record.surface && cell.harness === record.harness);
    assertExactIsoTimestamp(record.generated_at, `competitive record ${record.product}/${record.harness}/${record.surface} generated_at`);
    if (!pack || !pin || configured.length !== 3
      || record.standard_set_version !== pack.standard_set_version
      || record.model !== configured[0]!.model || record.harness_version_raw !== pin.version_raw
      || record.harness_version_semver !== pin.version_semver
      || record.blocked || record.summary_kind !== "aggregate" || record.validity_status !== "valid"
      || record.best_profile !== PUBLICATION_EFFORT || record.profiles.length !== 1
      || record.profiles[0] !== PUBLICATION_EFFORT || record.trial_count !== 3
      || record.trial_values?.length !== 3 || record.source_records?.length !== 3
      || new Set(record.source_records).size !== 3 || record.mean_pass_rate === undefined
      || record.range_pass_rate === undefined || record.range_pass_rate === null) {
      throw new Error("competitive records must be valid, unblocked, three-trial high-effort aggregates");
    }
    const mean = record.trial_values.reduce((sum, value) => sum + value, 0) / record.trial_values.length;
    const min = Math.min(...record.trial_values);
    const max = Math.max(...record.trial_values);
    if (Math.abs(mean - record.mean_pass_rate) > Number.EPSILON
      || Math.abs(mean - record.pass_at_1) > Number.EPSILON
      || record.range_pass_rate.min !== min || record.range_pass_rate.max !== max) {
      throw new Error("competitive aggregate metrics do not match their three trial values");
    }
  }

  for (const harness of harnesses) {
    const cohort = records.filter((record) => record.harness === harness);
    const models = new Set(cohort.map((record) => record.model).filter(Boolean));
    const versions = new Set(cohort.map((record) => record.harness_version_semver).filter(Boolean));
    if (models.size !== 1 || versions.size !== 1
      || cohort.some((record) => !record.model || !record.harness_version_semver)) {
      throw new Error(`competitive harness ${harness} must use one model and one exact harness version`);
    }
  }
}

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function code(value: unknown): string {
  return `<code class="ax-code">${esc(value)}</code>`;
}

function heat(value: number | null | undefined): string {
  if (value === null || value === undefined) return `<span class="ax-heat ax-heat--na">—</span>`;
  const css = value >= 0.8 ? "ax-heat--hi" : value >= 0.5 ? "ax-heat--mid" : "ax-heat--lo";
  return `<span class="ax-heat ${css}">${Math.round(value * 100)}%</span>`;
}

function blockedPill(reason: string): string {
  const label = reason === "requires-oauth"
    ? "OAuth req'd"
    : reason === "missing-harness" ? "no CLI" : reason === "invoke-failed" ? "invoke failed" : "no cred";
  return `<span class="ax-heat ax-heat--blocked" title="blocked: ${esc(reason)}">${esc(label)}</span>`;
}

function rankBadge(rank: number): string {
  return `<span class="ax-rank ${rank <= 3 ? `ax-rank--${rank}` : "ax-rank--n"}">${rank}</span>`;
}

function bySurfaceOrder(left: SurfaceId, right: SurfaceId): number {
  return SURFACE_ORDER.indexOf(left) - SURFACE_ORDER.indexOf(right);
}

function renderCrossSurface(records: NormalizedResult[]): string {
  const byProductHarness = new Map<string, NormalizedResult[]>();
  for (const record of records) {
    const key = JSON.stringify([record.product, record.harness]);
    byProductHarness.set(key, [...(byProductHarness.get(key) ?? []), record]);
  }
  const blocks = [...byProductHarness.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, productRecords]) => {
    const [product, harness] = JSON.parse(key) as [string, string];
    const sorted = [...productRecords].sort((left, right) => bySurfaceOrder(left.surface, right.surface));
    const bestScore = Math.max(...sorted.map((record) => record.pass_at_1));
    const bestCount = sorted.filter((record) => record.pass_at_1 === bestScore).length;
    const rows = sorted.map((record) => {
      if (record.blocked) {
        return `<tr class="ax-row--blocked">
          <td>${esc(record.surface)}</td><td>${blockedPill(record.blocked)}</td><td>${blockedPill(record.blocked)}</td>
          <td>${heat(record.discovery_score)}</td><td>${heat(record.content_quality)}</td><td>—</td>
        </tr>`;
      }
      const wins = record.pass_at_1 === bestScore && sorted.length > 1;
      const bestLabel = bestCount > 1 ? "tied best" : "best";
      return `<tr${wins ? ' class="ax-row--best"' : ""}>
          <td>${esc(record.surface)}${wins ? ` <span class="ax-task__diff">${bestLabel}</span>` : ""}</td>
          <td>${heat(record.pass_at_1)}</td>
          <td>${heat(record.pass_at_k)}${record.attempts > 1 ? ` <span class="ax-task__diff">(k=${esc(record.attempts)})</span>` : ""}</td>
          <td>${heat(record.discovery_score)}</td><td>${heat(record.content_quality)}</td>
          <td>${esc(record.tasks_passed)}/${esc(record.tasks_total)}</td>
        </tr>`;
    }).join("");
    return `<h3 class="ax-subhead">${esc(product)} / ${esc(harness)}</h3>
      <table class="ax-table"><thead><tr><th>surface</th><th>pass@1</th><th>pass@k</th><th>discovery</th><th>content</th><th>tasks</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join("\n      ");
  return `<section class="ax-section">
    <h2>Cross-surface (same product)</h2>
    <p class="ax-note">The same task bank + read-back oracle run across each surface a product exposes. Pass@1/pass@k come from the strongest profile; discovery is the share of Phase-0 signals it passed for that surface; content is the OpenAPI content-quality (smell) score, which is product-level (constant across a product's surfaces). This is the surface axis of the competitive cube — which interface serves agents best for each product.</p>
    ${blocks || '<p class="ax-empty">No surface results to compare.</p>'}
  </section>`;
}

function renderCrossProduct(records: NormalizedResult[], batch: ArenaBatchManifest): string {
  const byKey = new Map(records.map((record) => [JSON.stringify([record.product, record.harness, record.surface]), record]));
  const surfaces = [...new Set(batch.configuration.packs.flatMap((pack) => pack.surfaces))].sort(bySurfaceOrder);
  const harnesses = batch.configuration.harnesses.map((pin) => pin.harness).sort();
  const blocks = harnesses.flatMap((harness) => surfaces.map((surface) => {
    const supported = batch.configuration.packs.filter((pack) => pack.surfaces.includes(surface));
    const structuralNa = batch.configuration.packs.filter((pack) => !pack.surfaces.includes(surface));
    const ranked = supported.map((pack) => byKey.get(JSON.stringify([pack.vendor, harness, surface]))!)
      .sort((left, right) => right.pass_at_1 - left.pass_at_1
        || right.pass_at_k - left.pass_at_k || left.product.localeCompare(right.product));
    let previous: NormalizedResult | undefined;
    let previousRank = 0;
    const topScoreCount = ranked.filter((record) => ranked[0]
      && record.pass_at_1 === ranked[0].pass_at_1 && record.pass_at_k === ranked[0].pass_at_k).length;
    const rankedRows = ranked.map((record, index) => {
      const tied = previous && record.pass_at_1 === previous.pass_at_1 && record.pass_at_k === previous.pass_at_k;
      const rank = tied ? previousRank : index + 1;
      previous = record;
      previousRank = rank;
      const best = rank === 1 && ranked.length > 1;
      const label = topScoreCount > 1 ? "tied best" : "best";
      return `<tr${best ? ' class="ax-row--best"' : ""}>
          <td>${rankBadge(rank)}</td><td>${esc(record.product)}${best ? ` <span class="ax-task__diff">${label}</span>` : ""}</td><td>${heat(record.pass_at_1)}</td>
          <td>${heat(record.pass_at_k)}</td><td>${heat(record.discovery_score)}</td><td>${heat(record.content_quality)}</td>
        </tr>`;
    });
    const naRows = structuralNa.sort((left, right) => left.vendor.localeCompare(right.vendor)).map((pack) =>
      `<tr class="ax-row--blocked"><td>—</td><td>${esc(pack.vendor)}</td><td colspan="4"><span class="ax-heat ax-heat--na">structural N/A</span></td></tr>`);
    return `<h3 class="ax-subhead">${esc(surface)} / ${esc(harness)} leaderboard</h3>
      <table class="ax-table"><thead><tr><th>#</th><th>product</th><th>pass@1</th><th>pass@k</th><th>discovery</th><th>content</th></tr></thead><tbody>${[...rankedRows, ...naRows].join("")}</tbody></table>`;
  })).join("\n      ");
  return `<section class="ax-section">
    <h2>Cross-product (same surface)</h2>
    <p class="ax-note">A leaderboard per surface: which products are most agent-usable through that interface. Structurally unsupported vendor/surface cells are shown as N/A rather than omitted or scored as failures. <code class="ax-code">content</code> is the OpenAPI content-quality (smell) score — how usable each product's spec is once found.</p>
    ${blocks || '<p class="ax-empty">No product results to compare.</p>'}
  </section>`;
}

function renderCrossHarness(records: NormalizedResult[]): string {
  if (new Set(records.map((record) => record.harness)).size <= 1) return "";
  const byCell = new Map<string, NormalizedResult[]>();
  for (const record of records) {
    const key = `${record.product}::${record.surface}`;
    byCell.set(key, [...(byCell.get(key) ?? []), record]);
  }
  const blocks = [...byCell.entries()].filter(([, cell]) => new Set(cell.map((record) => record.harness)).size > 1)
    .map(([key, cell]) => {
      const [product, surface] = key.split("::");
      const runnable = cell.filter((record) => !record.blocked)
        .sort((left, right) => right.pass_at_1 - left.pass_at_1 || right.pass_at_k - left.pass_at_k);
      const bestScore = runnable[0]?.pass_at_1 ?? null;
      const bestPassAtK = runnable[0]?.pass_at_k ?? null;
      const bestCount = runnable.filter((record) =>
        record.pass_at_1 === bestScore && record.pass_at_k === bestPassAtK).length;
      const rows = [...cell].sort((left, right) => left.harness.localeCompare(right.harness)).map((record) => {
        const wins = bestScore !== null && record.pass_at_1 === bestScore
          && record.pass_at_k === bestPassAtK && runnable.length > 1;
        const bestLabel = bestCount > 1 ? "tied best" : "best";
        if (record.blocked) return `<tr class="ax-row--blocked"><td>${esc(record.harness)}</td><td>${blockedPill(record.blocked)}</td><td>${blockedPill(record.blocked)}</td><td>${heat(record.discovery_score)}</td><td>${heat(record.content_quality)}</td></tr>`;
        return `<tr${wins ? ' class="ax-row--best"' : ""}><td>${esc(record.harness)}${wins ? ` <span class="ax-task__diff">${bestLabel}</span>` : ""}</td><td>${heat(record.pass_at_1)}</td><td>${heat(record.pass_at_k)}</td><td>${heat(record.discovery_score)}</td><td>${heat(record.content_quality)}</td></tr>`;
      }).join("");
      return `<h3 class="ax-subhead">${esc(product)} / ${esc(surface)}</h3><table class="ax-table"><thead><tr><th>harness</th><th>pass@1</th><th>pass@k</th><th>discovery</th><th>content</th></tr></thead><tbody>${rows}</tbody></table>`;
    }).join("\n      ");
  return blocks ? `<section class="ax-section"><h2>Cross-harness (same product + surface)</h2><p class="ax-note">When multiple local harnesses have records for the same product/surface cell, this compares them without changing the oracle. A blocked local CLI is shown as blocked, not as a failed task run.</p>${blocks}</section>` : "";
}

export function renderArenaCompetitiveReport(
  records: NormalizedResult[],
  opts: { batch: ArenaBatchManifest; generatedAt?: string },
): string {
  const batch = ArenaBatchManifestSchema.parse(opts.batch);
  assertComparableCompetitiveRecords(batch, records);
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const harnesses = [...new Set(records.map((record) => record.harness))];
  const products = new Set(records.map((record) => record.product));
  const surfaces = new Set(records.map((record) => record.surface));
  const meta: Array<[string, string]> = [
    ["generated", esc(generatedAt)],
    ["harness", code(harnesses.join(", ") || "(unknown)")],
    ["batch", code(batch.batch_id)],
    ["products", esc(products.size)],
    ["surfaces", esc(surfaces.size)],
    ["cells", esc(records.length)],
  ];
  const rows = meta.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${value}</dd></div>`).join("\n      ");
  const body = [
    `<header class="ax-header"><div class="ax-eyebrow">Agent usability — competitive report</div><h1 class="ax-title">Which surface serves agents best?</h1><p class="ax-subtitle">The same tasks + read-back oracle, run across every surface (API / CLI / SDK / MCP) each product exposes. This is the surface × product plane.</p><dl class="ax-meta">${rows}</dl></header>`,
    `<main class="ax-main-inner">`,
    renderCrossSurface(records),
    renderCrossProduct(records, batch),
    renderCrossHarness(records),
    `<section class="ax-section"><h2>Methodology &amp; scope</h2><p class="ax-note">Each cell is a normalized <code class="ax-code">${esc(NORMALIZED_RESULT_SCHEMA)}</code> record keyed by { surface, product, harness }. Metrics report the strongest profile. The surface × product tables answer which interface serves agents best; the optional cross-harness table answers which local agent CLI performed best for the same product/surface, without changing the deterministic oracle.</p></section>`,
    `</main>`,
  ].join("\n");
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>AX eval — competitive report</title><style>${REPORT_STYLE}</style></head><body><div class="ax-main">${body}</div></body></html>\n`;
}

function writeAtomicReport(root: string, outPath: string, html: string): string {
  const output = resolveContained(root, outPath, "competitive output");
  const parent = dirname(output);
  assertNoSymlinkChain(root, parent, "competitive output parent");
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("competitive output parent must be an existing regular directory");
  }
  const realRoot = realpathSync(root);
  const realParent = realpathSync(parent);
  if (realParent !== realRoot && !inside(realRoot, realParent)) throw new Error("competitive output parent escapes the repository root");
  if (existsSync(output)) {
    const current = lstatSync(output);
    if (!current.isFile() || current.isSymbolicLink()) throw new Error("competitive output must be a regular file");
  }
  const parentDescriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let temporary: string | undefined;
  let temporaryIdentity: { dev: number; ino: number } | undefined;
  let temporarySnapshot: { size: number; mtimeMs: number; ctimeMs: number } | undefined;
  try {
    const parentIdentity = fstatSync(parentDescriptor);
    const assertPinnedParent = (): void => {
      assertNoSymlinkChain(root, parent, "competitive output parent");
      const current = lstatSync(parent);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(parentIdentity, current)
        || realpathSync(parent) !== realParent) throw new Error("competitive output parent changed during write");
    };
    assertPinnedParent();
    temporary = resolve(parent, `.competitive-${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const opened = fstatSync(descriptor);
      temporaryIdentity = { dev: Number(opened.dev), ino: Number(opened.ino) };
      assertPinnedParent();
      const current = lstatSync(temporary);
      if (current.isSymbolicLink() || !sameIdentity(temporaryIdentity, current)) throw new Error("competitive temporary file changed during write");
      writeFileSync(descriptor, html);
      fsyncSync(descriptor);
      const completedWrite = fstatSync(descriptor);
      temporarySnapshot = {
        size: completedWrite.size,
        mtimeMs: completedWrite.mtimeMs,
        ctimeMs: completedWrite.ctimeMs,
      };
    } finally {
      closeSync(descriptor);
    }
    assertPinnedParent();
    const staged = lstatSync(temporary);
    if (!temporarySnapshot || !staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1
      || !sameIdentity(temporaryIdentity!, staged) || staged.size !== temporarySnapshot.size
      || staged.mtimeMs !== temporarySnapshot.mtimeMs || staged.ctimeMs !== temporarySnapshot.ctimeMs) {
      throw new Error("competitive temporary file changed before publication");
    }
    if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error("competitive output cannot be a symlink");
    renameSync(temporary, output);
    fsyncSync(parentDescriptor);
    const completed = lstatSync(output);
    if (!completed.isFile() || completed.isSymbolicLink() || completed.nlink !== 1
      || !sameIdentity(temporaryIdentity, completed) || completed.size !== temporarySnapshot.size
      || completed.mtimeMs !== temporarySnapshot.mtimeMs
      || !inside(realParent, realpathSync(output))) throw new Error("competitive output escaped its pinned parent");
  } catch (error) {
    if (temporary && existsSync(temporary)) {
      const current = lstatSync(temporary);
      if (temporaryIdentity && current.isFile() && !current.isSymbolicLink() && sameIdentity(temporaryIdentity, current)) {
        rmSync(temporary, { force: true });
      }
    }
    throw error;
  } finally {
    closeSync(parentDescriptor);
  }
  return output;
}

export function writeArenaCompetitiveReport(opts: WriteArenaCompetitiveReportOptions): string {
  const requestedRoot = resolve(opts.root);
  const rootStat = lstatSync(requestedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("competitive root must be a regular directory");
  const root = realpathSync(requestedRoot);
  const bundleRoot = resolveContained(root, opts.bundleDir, "competitive publication bundle");
  const output = resolveContained(root, opts.outPath ?? "results/competitive.html", "competitive output");
  if (insideOrEqual(bundleRoot, output) || insideOrEqual(output, bundleRoot)) {
    throw new Error("competitive output must not overlap the sealed publication bundle");
  }
  assertArenaOutputRoot(root, output);
  const cohort = loadArenaPublicationCohort({ root, bundleDir: opts.bundleDir });
  const generatedAt = opts.generatedAt ?? new Date();
  if (!Number.isFinite(generatedAt.getTime())) throw new Error("competitive generatedAt must be a valid date");
  const records = cohort.records.map((entry) => entry.record);
  const html = renderArenaCompetitiveReport(records, {
    batch: cohort.batch,
    generatedAt: generatedAt.toISOString(),
  });
  return writeAtomicReport(root, opts.outPath ?? "results/competitive.html", html);
}
