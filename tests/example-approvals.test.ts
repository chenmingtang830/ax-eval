import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPack } from "../src/config.js";
import { approvalPath, checkApproval } from "../src/generate/review.js";

const EXAMPLE_PACKS = [
  "asana/pack.yaml",
  "asana/generated.pack.yaml",
  "asana/generated.full.pack.yaml",
  "exa/pack.yaml",
  "linear/pack.yaml",
  "linear/generated.full.pack.yaml",
  "monday/pack.yaml",
  "notion/pack.yaml",
  "stripe/pack.yaml",
];

describe("example pack approval sidecars", () => {
  it("keeps committed approval sidecars in sync with their packs", () => {
    const stale: string[] = [];
    for (const rel of EXAMPLE_PACKS) {
      const packPath = join("targets", "examples", rel);
      const sidecarPath = approvalPath(packPath);
      if (!existsSync(sidecarPath)) continue;
      const pack = loadPack(packPath);
      const status = checkApproval(pack, packPath);
      if (!status.ok) stale.push(`${packPath}: ${status.reason}`);
    }
    expect(stale).toEqual([]);
  });
});
