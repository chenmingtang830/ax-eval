import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { loadPack } from "../src/config.js";
import { TargetPackSchema } from "../src/schemas.js";
import {
  approvalPath,
  checkApproval,
  checkCellApproval,
  checkCommittedLegacyCellApproval,
  oracleTier,
  packQaIssues,
  packContentHash,
  packFileContentHash,
  reviewSummary,
  stageApprovedEquivalentPack,
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

  it("binds cell approval to the exact pack file, including surface configuration", () => {
    const p = pack({ surfaces: { cli: { bin: "example" } } });
    writeFileSync(packPath, yamlStringify(p));
    writeApproval(packPath, p, "tester");
    const approvedHash = packFileContentHash(packPath);
    expect(checkCellApproval(p, packPath, approvedHash).ok).toBe(true);

    writeFileSync(packPath, yamlStringify({ ...p, surfaces: { cli: { bin: "malicious-wrapper" } } }));
    expect(checkCellApproval(loadPack(packPath), packPath, packFileContentHash(packPath)).ok).toBe(false);
  });

  it("accepts a legacy approval only when exact pack and approval bytes are bound to the source commit", () => {
    const p = pack();
    writeFileSync(packPath, yamlStringify(p));
    writeFileSync(approvalPath(packPath), `${JSON.stringify({
      standard_set_version: p.standard_set_version,
      content_hash: packContentHash(p),
      approved_by: "legacy-reviewer",
      approved_at: "2026-01-01T00:00:00.000Z",
      task_count: p.tasks.length,
    }, null, 2)}\n`);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init");
    git("config", "user.name", "Review Test");
    git("config", "user.email", "review@example.invalid");
    git("add", ".");
    git("-c", "commit.gpgSign=false", "commit", "-m", "legacy reviewed pack");
    const sourceCommitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const expected = packFileContentHash(packPath);

    expect(checkCellApproval(p, packPath, expected)).toMatchObject({ ok: false });
    expect(checkCommittedLegacyCellApproval(p, packPath, expected, {
      repositoryRoot: dir,
      sourceCommitSha,
      sourcePackPath: "generated.pack.yaml",
    })).toEqual({ ok: true });

    const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
    expect(checkCommittedLegacyCellApproval(p, packPath, expected, {
      repositoryRoot: dir,
      sourceCommitSha: treeSha,
    })).toEqual({ ok: false, reason: "legacy approval source SHA must identify a commit object" });

    writeFileSync(approvalPath(packPath), `${JSON.stringify({
      standard_set_version: p.standard_set_version,
      content_hash: packContentHash(p),
      approved_by: "different-reviewer",
      approved_at: "2026-01-01T00:00:00.000Z",
      task_count: p.tasks.length,
    })}\n`);
    expect(checkCommittedLegacyCellApproval(p, packPath, expected, {
      repositoryRoot: dir,
      sourceCommitSha,
    })).toMatchObject({ ok: false });
  }, 20_000);

  it("approval sidecar sits next to the pack", () => {
    expect(approvalPath("/x/generated.pack.yaml")).toBe("/x/generated.pack.approval.json");
  });

  it("stages an equivalent runtime pack with the committed human approval", () => {
    const approvedPack = pack();
    const candidatePath = join(dir, "run", "compiled.pack.yaml");
    mkdirSync(join(dir, "run"), { recursive: true });
    writeFileSync(candidatePath, yamlStringify(approvedPack));
    writeApproval(packPath, approvedPack, "tester");
    const serializedCandidate = loadPack(candidatePath);

    const stagedApproval = stageApprovedEquivalentPack({
      approvedPack,
      approvedPackPath: packPath,
      candidatePack: serializedCandidate,
      candidatePackPath: candidatePath,
    });

    expect(stagedApproval).toBe(approvalPath(candidatePath));
    expect(existsSync(stagedApproval)).toBe(true);
    expect(checkApproval(loadPack(candidatePath), candidatePath).ok).toBe(true);
  });

  it("refuses to stage runtime pack content that differs from the approval", () => {
    const approvedPack = pack();
    const candidatePath = join(dir, "candidate.pack.yaml");
    writeFileSync(candidatePath, "name: t\n");
    writeApproval(packPath, approvedPack, "tester");

    expect(() => stageApprovedEquivalentPack({
      approvedPack,
      approvedPackPath: packPath,
      candidatePack: pack({ tasks: [{ id: "changed", prompt: "changed", oracles: [] }] }),
      candidatePackPath: candidatePath,
    })).toThrow(/does not match the approved committed pack/);
    expect(existsSync(approvalPath(candidatePath))).toBe(false);
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

  it("flags free-choice prompts with a tightly bound oracle resource", () => {
    const p = pack({
      tasks: [
        {
          id: "decisions-log",
          difficulty: "L3",
          prompt: "Choose an appropriate Notion structure called AX decisions {ns}. Report its id.",
          allowed_surfaces: ["api", "cli", "sdk", "mcp", "docs"],
          oracles: [
            {
              type: "roundtrip",
              readPathTemplate: "/v1/data_sources/{gid}",
              assertField: "title.0.plain_text",
              expected: "AX decisions {ns}",
            },
          ],
        },
      ],
    });
    const issues = packQaIssues(p);
    expect(issues.map((i) => i.code)).toContain("free-choice-bound-oracle");
    expect(reviewSummary(p)).toMatch(/Pack QA/);
  });

  it("flags prompt/oracle resource mismatches", () => {
    const p = pack({
      tasks: [
        {
          id: "database-read-as-data-source",
          prompt: "Create a Notion database titled AX decisions {ns}. Report the database id.",
          oracles: [
            {
              type: "roundtrip",
              readPathTemplate: "/v1/data_sources/{gid}",
              assertField: "title.0.plain_text",
              expected: "AX decisions {ns}",
            },
          ],
        },
      ],
    });
    expect(packQaIssues(p).map((i) => i.code)).toContain("prompt-oracle-resource-mismatch");
  });

  it("does not flag an explicit database prompt with a database oracle", () => {
    const p = pack({
      tasks: [
        {
          id: "decisions-log",
          prompt: "Create a Notion database titled AX decisions {ns}. Report the database id.",
          oracles: [
            {
              type: "roundtrip",
              readPathTemplate: "/v1/databases/{gid}",
              assertField: "title.0.plain_text",
              expected: "AX decisions {ns}",
            },
          ],
        },
      ],
    });
    expect(packQaIssues(p).map((i) => i.code)).not.toContain("free-choice-bound-oracle");
    expect(packQaIssues(p).map((i) => i.code)).not.toContain("prompt-oracle-resource-mismatch");
  });

  it("does not mistake transport endpoints for business resources", () => {
    const p = pack({
      tasks: [
        {
          id: "sql-pipeline-query",
          prompt: "Query rows in pages of 5 and return the first two pages.",
          oracles: [
            {
              type: "roundtrip",
              readMethod: "POST",
              readPathTemplate: "/v2/pipeline",
              assertField: "results.0.response.result.rows.0.0.value",
              expected: "5",
            },
          ],
        },
      ],
    });
    expect(packQaIssues(p).map((i) => i.code)).not.toContain("prompt-oracle-resource-mismatch");
  });

  it("flags zero-count oracles on create-structure tasks as final-state fragile", () => {
    const p = pack({
      tasks: [
        {
          id: "create-table-empty",
          prompt: "Create a new table named axarena_customers_{ns}.",
          oracles: [
            {
              type: "roundtrip",
              assertField: "length",
              expected: 0,
            },
          ],
        },
      ],
    });
    expect(packQaIssues(p).map((i) => i.code)).toContain("final-state-fragile-oracle");
  });

  it("does not flag limit=0 existence checks as fragile zero-count oracles", () => {
    const p = pack({
      tasks: [
        {
          id: "create-table-limit-zero",
          prompt: "Create a new table named axarena_customers_{ns}.",
          oracles: [
            {
              type: "roundtrip",
              readPathTemplate: "/rest/v1/axarena_customers_{ns}?select=id&limit=0",
              assertField: "length",
              expected: 0,
            },
          ],
        },
      ],
    });
    expect(packQaIssues(p).map((i) => i.code)).not.toContain("final-state-fragile-oracle");
  });

  it("flags literal email/domain mismatches between prompt and oracle", () => {
    const p = pack({
      tasks: [
        {
          id: "literal-mismatch",
          prompt: "Return rows where email matches probe-9%@axarena-{ns}.test.",
          oracles: [
            {
              type: "roundtrip",
              assertField: "0.email",
              expected: "probe-1@example.com",
            },
          ],
        },
      ],
    });
    expect(packQaIssues(p).map((i) => i.code)).toContain("literal-constraint-mismatch");
  });

  it("flags advanced data source/view tasks enabled on every surface", () => {
    const p = pack({
      tasks: [
        {
          id: "data-source-view",
          prompt: "Create a data source and add a table view named AX view {ns}. Report the view id.",
          allowed_surfaces: ["api", "cli", "sdk", "mcp"],
          oracles: [
            {
              type: "roundtrip",
              readPathTemplate: "/v1/views/{gid}",
              assertField: "name",
              expected: "AX view {ns}",
            },
          ],
        },
      ],
    });
    const codes = packQaIssues(p).map((i) => i.code);
    expect(codes).toContain("surface-risk");
    expect(codes).not.toContain("ambiguous-reported-id");
  });
});
