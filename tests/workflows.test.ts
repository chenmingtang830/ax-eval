import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function workflow(name: string): string {
  return readFileSync(resolve(process.cwd(), ".github", "workflows", name), "utf8");
}

describe("records automation workflows", () => {
  it("keeps the PR fixture diff keyless and gives forks only summary/artifact output", () => {
    const source = workflow("records-diff.yml");
    expect(source).toContain("pull_request:");
    expect(source).not.toContain("pull_request_target");
    expect(source).not.toMatch(/secrets\./);
    expect(source).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(source).toContain("pull-requests: write");
    expect(source).toContain("GITHUB_STEP_SUMMARY");
    expect(source).toContain("normalized-records-fixture-diff");
  });

  it("gates live production on the trusted environment and canonical cleanup-safe command", () => {
    const source = workflow("trusted-sandbox-records.yml");
    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("environment: trusted-sandbox");
    expect(source).toContain("daeb-production-rerun");
    expect(source).toContain("--vendor \"$VENDOR\" --surface \"$SURFACE\"");
    expect(source).not.toContain("--skip-reset");
    expect(source).not.toContain("--trial-count");
    expect(source).not.toContain("--codex-model");
    expect(source).not.toContain("--claude-model");
    expect(source).toContain("name: normalized-records");
    expect(source).toContain("inputs.pr_number != ''");
  });
});
