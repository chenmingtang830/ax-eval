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

  it("gates live production on protected source, an immutable runtime, and isolated OIDC attestation", () => {
    const source = workflow("trusted-sandbox-records.yml");
    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("environment: trusted-sandbox");
    expect(source).toContain("git merge-base --is-ancestor");
    expect(source).toContain("git diff --quiet");
    expect(source).toMatch(/node:22\.23\.1-bookworm@sha256:[a-f0-9]{64}/);
    expect(source).not.toContain("ubuntu-latest");
    expect(source).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(source).toContain('node-version: "22.23.1"');
    expect(source).not.toContain("apt-get");
    expect(source).not.toContain("npm install --global");
    expect(source).toContain('npm" ci --ignore-scripts');
    expect(source).not.toContain("seccomp=unconfined");
    expect(source).not.toContain("--privileged");
    expect(source).toContain("prepare-trusted-runtime.mjs");
    expect(source).toContain("smoke-trusted-runtime.mjs");
    expect(source).toContain("trusted-cell.ts");
    expect(source).toContain("export-trusted-run.mjs");
    expect(source).toContain("path: ${{ runner.temp }}/trusted-arena-export-");
    expect(source).not.toContain("path: results/runs/trusted-");
    expect(source).not.toContain("--skip-reset");
    expect(source).not.toContain("--trial-count");
    expect(source).not.toContain("--codex-model");
    expect(source).not.toContain("--claude-model");
    expect(source).toContain("id-token: write");
    expect(source).toContain("attestations: write");
    expect(source).toContain("artifact-metadata: write");
    expect(source).toContain("actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6");
    expect(source).toContain("subject-path: trusted-run/trusted-run-subject.json");
    const cohort = source.slice(source.indexOf("  cohort:"), source.indexOf("  attest:"));
    const attest = source.slice(source.indexOf("  attest:"));
    expect(cohort).not.toContain("id-token: write");
    expect(cohort).not.toContain("attestations: write");
    expect(attest).not.toContain("environment: trusted-sandbox");
    expect(attest).not.toContain("secrets.");
  });
});
