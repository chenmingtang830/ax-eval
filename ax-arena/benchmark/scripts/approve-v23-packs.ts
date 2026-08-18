#!/usr/bin/env node
/** Write standard sidecars only after an exact V2.3 pack review is approved. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadPack, writeApproval } from "ax-eval";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const reviewPath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/pack-review.json");
const approvalRecord = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/pack-approval.json");
const reviewer = process.env.DAEB_V23_PACK_APPROVER?.trim();
if (!reviewer) throw new Error("DAEB_V23_PACK_APPROVER is required after human review");
const review = JSON.parse(readFileSync(reviewPath, "utf8")) as {
  status?: string; suite?: { sha256?: string }; packs?: Record<string, { pack: string; pack_sha256: string }>;
};
if (review.status !== "reviewed-and-approved") {
  throw new Error(`refusing pack approval while review status is ${review.status ?? "missing"}`);
}
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sidecars: Record<string, unknown> = {};
for (const [vendor, item] of Object.entries(review.packs ?? {})) {
  const pack = resolve(ROOT, item.pack);
  if (hash(pack) !== item.pack_sha256) throw new Error(`${vendor} pack changed after review`);
  const approval = writeApproval(pack, loadPack(pack), reviewer);
  sidecars[vendor] = { pack: item.pack, pack_sha256: item.pack_sha256, approval };
}
if (!Object.keys(sidecars).length) throw new Error("review contains no packs");
writeFileSync(approvalRecord, JSON.stringify({
  schema: "ax.daeb-v2-3-pack-approval/v1",
  status: "approved",
  reviewer,
  approved_at: new Date().toISOString(),
  review_sha256: hash(reviewPath),
  suite_sha256: review.suite?.sha256,
  sidecars,
}, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ approval_record: approvalRecord, vendors: Object.keys(sidecars) }, null, 2));
