import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function workflow(name: string): string {
  return readFileSync(resolve(REPOSITORY_ROOT, ".github", "workflows", name), "utf8");
}

describe("trusted arena workflow launcher", () => {
  it("keeps benchmark policy in arena-owned scripts and only bindings in GitHub YAML", () => {
    const source = workflow("trusted-sandbox-records.yml");
    const preparation = readFileSync(resolve(REPOSITORY_ROOT, "ax-arena", "benchmark", "scripts", "prepare-trusted-tools.sh"), "utf8");
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
    expect(preparation).toContain('npm" ci --ignore-scripts');
    expect(source).not.toContain("seccomp=unconfined");
    expect(source).not.toContain("--privileged");
    for (const script of [
      "validate-trusted-dispatch.mjs",
      "prepare-trusted-tools.sh",
      "smoke-trusted-runtime.mjs",
      "trusted-cell.ts",
      "trusted-attestation.mjs",
      "export-trusted-run.mjs",
    ]) expect(source).toContain(`ax-arena/benchmark/scripts/${script}`);
    expect(preparation).toContain("prepare-trusted-sysroot.sh");
    expect(preparation).toContain("prepare-trusted-runtime.mjs");
    expect(source).not.toMatch(/\.github\/(?:validate|prepare|smoke|trusted|export)[^\s]*/);
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
    for (const action of source.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)) {
      expect(action[1]).toMatch(/^[a-f0-9]{40}$/);
    }
  });
});
