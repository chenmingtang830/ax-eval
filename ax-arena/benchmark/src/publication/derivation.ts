import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { NormalizedCellRecordSchema } from "ax-eval";
import {
  ArenaCellCleanupSchema,
  type ArenaBatchCompletion,
  type ArenaBatchManifest,
  type ArenaRuntimeReport,
} from "../controller/schemas.js";
import { writeRuntimeReportingBundle } from "../controller/reporting.js";
import { readCanonicalJson, readPinnedFile } from "./filesystem.js";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function writeScratchFile(root: string, path: string, bytes: Buffer): void {
  const output = resolve(root, path);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
}

/** Rebuild every report artifact from sealed cells in a private scratch tree.
 * This is intentionally run both before bundle publication and by every
 * downstream loader so a rewritten self-hashed report cannot become official. */
export function assertCanonicalRuntimeDerivation(input: {
  runRoot: string;
  batch: ArenaBatchManifest;
  batchBytes: Buffer;
  completion: ArenaBatchCompletion;
  report: ArenaRuntimeReport;
  packPaths: Readonly<Record<string, string>>;
}): void {
  if (input.report.generated_at !== input.completion.completed_at) {
    throw new Error("runtime reporting timestamp must equal the signed batch completion timestamp");
  }
  const scratch = mkdtempSync(resolve(tmpdir(), "ax-arena-publication-recompute-"));
  try {
    writeScratchFile(scratch, "batch.json", input.batchBytes);
    const completion = structuredClone(input.completion);
    for (const cell of completion.cells) {
      const originalRecord = readCanonicalJson(
        input.runRoot,
        resolve(input.runRoot, cell.record_path),
        `attested record ${cell.key}`,
        (value) => NormalizedCellRecordSchema.parse(value),
      ).value;
      const scratchArtifactRoot = resolve(scratch, dirname(cell.record_path), "artifacts");
      const record = { ...originalRecord, artifacts: { ...originalRecord.artifacts, base_dir: scratchArtifactRoot } };
      const recordBytes = canonicalJson(record);
      writeScratchFile(scratch, cell.record_path, recordBytes);
      for (const artifact of cell.artifacts) {
        const source = readPinnedFile(
          input.runRoot,
          resolve(input.runRoot, artifact.path),
          `attested ${artifact.name} artifact ${cell.key}`,
        );
        if (sha256(source.bytes) !== artifact.sha256) {
          throw new Error(`attested ${artifact.name} artifact hash drifted: ${cell.key}`);
        }
        writeScratchFile(scratch, artifact.path, source.bytes);
      }
      const originalCleanup = readCanonicalJson(
        input.runRoot,
        resolve(input.runRoot, cell.cleanup_path),
        `attested cleanup ${cell.key}`,
        (value) => ArenaCellCleanupSchema.parse(value),
      ).value;
      const cleanup = {
        ...originalCleanup,
        record_path: resolve(scratch, cell.record_path),
        record_sha256: sha256(recordBytes),
      };
      const cleanupBytes = canonicalJson(cleanup);
      writeScratchFile(scratch, cell.cleanup_path, cleanupBytes);
      cell.record_hash = sha256(recordBytes);
      cell.cleanup_hash = sha256(cleanupBytes);
    }
    writeScratchFile(scratch, "batch-completion.json", canonicalJson(completion));
    const recomputed = writeRuntimeReportingBundle({
      runRoot: scratch,
      batch: input.batch,
      packPaths: input.packPaths,
      now: new Date(input.report.generated_at),
    });
    const normalizedRecomputed = {
      ...recomputed,
      batch_completion_sha256: input.report.batch_completion_sha256,
      aggregates: recomputed.aggregates.map((entry) => {
        const original = input.report.aggregates.find((candidate) =>
          candidate.vendor === entry.vendor && candidate.surface === entry.surface && candidate.harness === entry.harness);
        return original ? { ...entry, trial_manifest_sha256: original.trial_manifest_sha256 } : entry;
      }),
    };
    if (!isDeepStrictEqual(normalizedRecomputed, input.report)) {
      throw new Error("runtime reporting manifest does not match exact attested-cell recomputation");
    }
    for (const reported of input.report.surface_reports) {
      const expected = recomputed.surface_reports.find((candidate) =>
        candidate.vendor === reported.vendor && candidate.surface === reported.surface);
      if (!expected) throw new Error(`canonical runtime report omitted ${reported.vendor}/${reported.surface}`);
      for (const [path, expectedPath, label] of [
        [reported.snapshot_path, expected.snapshot_path, "snapshot"],
        [reported.html_path, expected.html_path, "HTML report"],
        [reported.failure_review_path, expected.failure_review_path, "failure review"],
      ] as const) {
        const actualBytes = readPinnedFile(input.runRoot, resolve(input.runRoot, path), `runtime ${label}`).bytes;
        const expectedBytes = readPinnedFile(scratch, resolve(scratch, expectedPath), `recomputed ${label}`).bytes;
        if (!actualBytes.equals(expectedBytes)) {
          throw new Error(`runtime ${label} does not match attested-cell recomputation: ${reported.vendor}/${reported.surface}`);
        }
      }
    }
    for (const reported of input.report.aggregates) {
      const expected = recomputed.aggregates.find((candidate) =>
        candidate.vendor === reported.vendor && candidate.surface === reported.surface && candidate.harness === reported.harness);
      if (!expected) throw new Error(`canonical runtime aggregation omitted ${reported.vendor}/${reported.surface}/${reported.harness}`);
      for (const [path, expectedPath, label] of [
        [reported.aggregate_record_path, expected.aggregate_record_path, "aggregate"],
      ] as const) {
        const actualBytes = readPinnedFile(input.runRoot, resolve(input.runRoot, path), `runtime ${label}`).bytes;
        const expectedBytes = readPinnedFile(scratch, resolve(scratch, expectedPath), `recomputed ${label}`).bytes;
        if (!actualBytes.equals(expectedBytes)) {
          throw new Error(`runtime ${label} does not match attested-cell recomputation: ${reported.vendor}/${reported.surface}/${reported.harness}`);
        }
      }
      const configured = input.batch.configuration.cells
        .filter((cell) => cell.vendor === reported.vendor && cell.surface === reported.surface && cell.harness === reported.harness)
        .sort((left, right) => left.trial - right.trial);
      const completed = new Map(input.completion.cells.map((cell) => [cell.key, cell]));
      const expectedTrialManifest = canonicalJson({
        schema: "ax.arena-runtime-trials/v1",
        batch_id: input.batch.batch_id,
        vendor: reported.vendor,
        surface: reported.surface,
        harness: reported.harness,
        generated_at: input.report.generated_at,
        trials: configured.map((cell) => {
          const completion = completed.get(cell.key);
          if (!completion) throw new Error(`canonical trial manifest omitted completed cell ${cell.key}`);
          return { trial: cell.trial, record_path: completion.record_path, record_hash: completion.record_hash };
        }),
      });
      const actualTrialManifest = readPinnedFile(
        input.runRoot,
        resolve(input.runRoot, reported.trial_manifest_path),
        `runtime trial manifest ${reported.vendor}/${reported.surface}/${reported.harness}`,
      ).bytes;
      if (!actualTrialManifest.equals(expectedTrialManifest)) {
        throw new Error(`runtime trial manifest does not match attested-cell recomputation: ${reported.vendor}/${reported.surface}/${reported.harness}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
