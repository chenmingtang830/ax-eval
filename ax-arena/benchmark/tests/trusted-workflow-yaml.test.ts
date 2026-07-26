import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function workflow(name: string): string {
  return readFileSync(resolve(REPOSITORY_ROOT, ".github", "workflows", name), "utf8");
}

describe("trusted arena workflow launcher", () => {
  it("fans out one pinned OCI runtime and protected credential scope per immutable cell", () => {
    const source = workflow("trusted-sandbox-records.yml");
    const preparation = readFileSync(resolve(
      REPOSITORY_ROOT,
      "ax-arena",
      "benchmark",
      "scripts",
      "prepare-trusted-tools.sh",
    ), "utf8");
    expect(source).toContain("name: Trusted sandbox arena benchmark");
    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("git merge-base --is-ancestor");
    expect(source).toContain("git diff --quiet");
    expect(source).toMatch(/node:22\.23\.1-bookworm@sha256:[a-f0-9]{64}/);
    expect(source).toContain("ubuntu-22.04");
    expect(source).toContain('"group":"ax-arena-trusted"');
    expect(source).toContain("options: [github-hosted, approved-self-hosted]");
    expect(source).toContain("matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}");
    expect(source).toContain("name: ${{ matrix.environment_name }}");
    expect(source).toContain("AX_ARENA_CELL_CREDENTIALS_JSON: ${{ secrets.AX_ARENA_CELL_CREDENTIALS_JSON }}");
    expect(source.match(/secrets\./g)).toHaveLength(1);
    expect(source).toContain("dist/trusted-plan.js");
    expect(source).toContain("dist/trusted-worker.js");
    expect(source).toContain("dist/assemble-trusted-completion.js");
    expect(source).toContain('--runtime-manifest "$RUN_ROOT/runtime-manifest.json"');
    expect(source).toContain('--runtime-manifests-root "$RUN_ROOT/runtime-manifests"');
    expect(source).toContain("runtime_manifest_name");
    expect(source).toContain("ax-arena/benchmark/tsconfig.build.json");
    expect(source).toContain("ax-arena/benchmark/.npmrc");
    expect(source).toContain("tsup.config.cts");
    expect(source).toContain("transfer-manifest.json");
    expect(source).toContain("artifact-invoke_metadata.bin");
    expect(source).toContain("artifact-transcript.bin");
    expect(source).not.toContain("workspace/artifacts/*");
    expect(source).not.toContain("workspace/**");
    expect(source).not.toContain("trusted-tools.tgz");
    expect(source).not.toContain("AX_ARENA_TRUSTED_PATH");
    expect(source).not.toContain("AX_ARENA_BWRAP_SHA256");
    expect(source).not.toContain("inputs.vendor");
    expect(source).not.toContain("inputs.surface");
    expect(source).not.toContain("turso_cli_url");
    expect(source).not.toContain("seccomp=unconfined");
    expect(source).not.toContain("--privileged");
    expect(source).not.toContain("apt-get");
    expect(source).not.toContain("npm install --global");
    expect(preparation).toContain("prepare-trusted-sysroot.sh");
    expect(preparation).toContain("prepare-trusted-runtime.mjs");
    expect(preparation).toContain('npm" ci --ignore-scripts');

    const plan = source.slice(source.indexOf("  plan:"), source.indexOf("  cell:"));
    const cell = source.slice(source.indexOf("  cell:"), source.indexOf("  assemble:"));
    const assemble = source.slice(source.indexOf("  assemble:"), source.indexOf("  attest:"));
    const attest = source.slice(source.indexOf("  attest:"));
    expect(plan).not.toContain("secrets.");
    expect(plan).not.toContain("environment:");
    expect(plan).toContain('mktemp "$RUNNER_TEMP/ax-arena-global-npmrc.XXXXXX"');
    expect(plan).toContain("env -i HOME=\"$HOME\" PATH=\"$PATH\"");
    expect(cell.indexOf("Reverify and prepare the exact OCI runtime before credentials"))
      .toBeLessThan(cell.indexOf("Execute exactly one immutable arena cell"));
    expect(cell).toContain("vars.AX_ARENA_APPROVED_SIGNER_SHA");
    expect(cell.indexOf("vars.AX_ARENA_APPROVED_SIGNER_SHA"))
      .toBeLessThan(cell.indexOf("secrets.AX_ARENA_CELL_CREDENTIALS_JSON"));
    expect(assemble).not.toContain("secrets.");
    expect(assemble).not.toContain("environment:");
    expect(assemble).toContain('mktemp "$RUNNER_TEMP/ax-arena-global-npmrc.XXXXXX"');
    expect(assemble).toContain("NPM_CONFIG_GLOBALCONFIG=\"$empty_npmrc\"");
    expect(attest).toContain("environment: trusted-sandbox");
    expect(attest).not.toContain("secrets.");
    expect(attest).toContain("vars.AX_ARENA_APPROVED_SIGNER_SHA");
    expect(attest).toContain("id-token: write");
    expect(attest).toContain("attestations: write");
    expect(attest).toContain("actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6");
    expect(attest).toContain("subject-path: trusted-run/trusted-run-subject.json");

    for (const action of source.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)) {
      expect(action[1]).toMatch(/^[a-f0-9]{40}$/);
    }
    expect(source).not.toContain("pull_request:");
    expect(source).not.toContain("pull_request_target");
    const parsed = parse(source) as { jobs: Record<string, { steps?: Array<{ run?: string }> }> };
    for (const job of Object.values(parsed.jobs)) {
      for (const step of job.steps ?? []) {
        expect(step.run ?? "", "workflow expressions must not be interpolated into shell source")
          .not.toContain("${{");
      }
    }
  });
});
