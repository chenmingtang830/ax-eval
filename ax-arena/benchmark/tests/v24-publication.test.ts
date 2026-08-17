import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const PUBLICATION = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-4/publication");
const json = (name: string): any => JSON.parse(readFileSync(resolve(PUBLICATION, name), "utf8"));
const sha = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

describe("V2.4 frozen publication package", () => {
  it("keeps vendors primary and declares the exact admitted denominator", () => {
    const publication = json("publication.json");
    const vendors = json("vendor-summary.json");
    const models = json("model-slices.json");
    expect(publication).toMatchObject({ formal: false, primary_unit: "vendor" });
    expect(publication.sample).toMatchObject({ atomic_cells: 420, j01_sessions: 70 });
    expect(vendors.rows).toHaveLength(5);
    expect(vendors.rows.every((row: any) => row.outcome_metrics.j01.planned === 14)).toBe(true);
    expect(models).toMatchObject({ role: "supplementary" });
    expect(models.rows).toHaveLength(7);
  });

  it("retains all final audits and admits no invalid observation", () => {
    const publication = json("publication.json");
    const evidence = json("evidence-index.json");
    expect(evidence.archives).toHaveLength(28);
    for (const family of ["atomic_status_counts", "j01_status_counts"]) {
      for (const status of ["invalid-infra", "invalid-route", "invalid-evidence"]) {
        expect(publication.sample[family][status] ?? 0).toBe(0);
      }
    }
  });

  it("declares the public and external archive disposition", () => {
    const evidence = json("evidence-index.json");
    const archive = json("archive-manifest.json");
    expect(archive).toMatchObject({
      external_archive_required: false,
      external_archives: [],
      public_evidence: { disposition: "embedded-in-repository", root: "evidence/", archive_count: 28 },
      raw_local_evidence: { disposition: "excluded-from-publication", locator_disclosed: false },
    });
    expect(archive.public_evidence.archive_count).toBe(evidence.archives.length);
    expect(archive.public_evidence.file_count).toBeGreaterThan(100);
    expect(archive.public_evidence.bytes).toBeGreaterThan(0);
  });

  it("matches every committed SHA-256 and contains no workstation path", () => {
    const checksums = json("checksums.json");
    for (const entry of checksums.files) {
      const content = readFileSync(resolve(PUBLICATION, entry.path));
      expect(content.length, entry.path).toBe(entry.bytes);
      expect(sha(content), entry.path).toBe(entry.sha256);
      const text = content.toString("utf8");
      expect(text, entry.path).not.toMatch(/\/Users\/[^/]+\/ax-eval\//);
      expect(text, entry.path).not.toMatch(/\/private\/var\/folders\//);
    }
  });
});
