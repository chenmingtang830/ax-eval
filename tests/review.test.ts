import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TargetPackSchema } from "../src/schemas.js";
import {
  approvalPath,
  checkApproval,
  oracleTier,
  packContentHash,
  reviewSummary,
  writeApproval,
} from "../src/generate/review.js";

function pack(overrides: Record<string, unknown> = {}) {
  return TargetPackSchema.parse({
    name: "t",
    standard_set_version: "v1",
    base_url: "https://api.example.test",
    tasks: [
      {
        id: "create-thing",
        difficulty: "L1",
        prompt: "Create a thing named {ns}",
        allowed_surfaces: ["docs", "api"],
        oracles: [{ type: "roundtrip", assertField: "name", expected: "x" }],
      },
    ],
    ...overrides,
  });
}

describe("review gate", () => {
  let dir: string;
  let packPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ax-review-"));
    packPath = join(dir, "generated.pack.yaml");
    writeFileSync(packPath, "name: t\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("derives T1/high for roundtrip and T2/low for weaker oracles", () => {
    expect(oracleTier({ type: "roundtrip" } as never).tier).toBe("T1");
    expect(oracleTier({ type: "roundtrip" } as never).confidence).toBe("high");
    expect(oracleTier({ type: "exists" } as never).tier).toBe("T2");
    expect(oracleTier({ type: "equals" } as never).confidence).toBe("low");
  });

  it("hash is stable across re-parse and changes with content", () => {
    const a = packContentHash(pack());
    const b = packContentHash(pack());
    expect(a).toBe(b);
    const c = packContentHash(pack({ tasks: [{ id: "x", prompt: "different", oracles: [] }] }));
    expect(c).not.toBe(a);
  });

  it("gate is closed until approved, then matches", () => {
    const p = pack();
    expect(checkApproval(p, packPath).ok).toBe(false);
    writeApproval(packPath, p, "tester");
    expect(checkApproval(p, packPath).ok).toBe(true);
  });

  it("re-closes the gate when the pack changes after approval", () => {
    const p = pack();
    writeApproval(packPath, p, "tester");
    const changed = pack({ tasks: [{ id: "create-thing", prompt: "now malicious rm -rf", oracles: [] }] });
    const status = checkApproval(changed, packPath);
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/changed since approval/);
  });

  it("approval sidecar sits next to the pack", () => {
    expect(approvalPath("/x/generated.pack.yaml")).toBe("/x/generated.pack.approval.json");
  });

  it("summary flags a task with no oracle", () => {
    const md = reviewSummary(pack({ tasks: [{ id: "naked", prompt: "do it", oracles: [] }] }));
    expect(md).toMatch(/NO ORACLE/);
  });

  it("does not describe stateless packs as write operations", () => {
    const md = reviewSummary(pack({ sandbox_scope: [] }));
    expect(md).toMatch(/call the live product/);
    expect(md).not.toMatch(/write-ops/);
  });
});
