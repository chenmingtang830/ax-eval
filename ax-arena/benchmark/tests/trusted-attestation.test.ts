import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(process.cwd(), "scripts", "trusted-attestation.mjs");
const sourceRoot = resolve(process.cwd(), "../..");
const canonical = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function fixture() {
  const runRoot = mkdtempSync(resolve(tmpdir(), "ax-trusted-attestation-"));
  const source = "a".repeat(40);
  const lockHash = "b".repeat(64);
  const configuration = {
    command: "daeb-production-rerun",
    execution: { runtime_backend: "pinned-oci", trust_level: "hosted-trusted" },
    sandbox: { runtime_lock_sha256: lockHash },
  };
  const runtimeManifest = {
    schema: "ax.arena-trusted-runtime-manifest/v1",
    runtime_lock_path: "ax-arena/benchmark/trusted-runtime/runtime-lock.json",
    runtime_lock_sha256: lockHash,
    sysroot: "/opt/ax-arena-runtime/rootfs",
    container: { digest: "sha256:" + "c".repeat(64) },
    tools_tree_sha256: "d".repeat(64),
  };
  const batch = {
    schema: "ax.arena-batch/v1",
    batch_id: "batch-1",
    source_commit_sha: source,
    configuration_hash: "e".repeat(64),
    configuration,
  };
  const completion = {
    schema: "ax.arena-batch-completion/v1",
    batch_id: "batch-1",
    source_commit_sha: source,
    configuration_hash: "e".repeat(64),
    runtime_manifest_sha256: createHash("sha256").update(canonical(runtimeManifest)).digest("hex"),
    completed_at: "2026-07-22T00:00:00.000Z",
    cells: [{ key: "neon/api/codex/trial-1" }],
  };
  for (const [name, value] of [
    ["runtime-manifest.json", runtimeManifest],
    ["configuration.json", configuration],
    ["batch.json", batch],
    ["batch-completion.json", completion],
  ] as const) writeFileSync(resolve(runRoot, name), canonical(value));
  const output = resolve(runRoot, "trusted-run-subject.json");
  const env = {
    ...process.env,
    AX_ARENA_SOURCE_SHA: source,
    PROTECTED_DEFAULT_BRANCH: "main",
    GITHUB_REPOSITORY: "example/ax-eval",
    GITHUB_WORKFLOW_REF: "example/ax-eval/.github/workflows/trusted-sandbox-records.yml@refs/heads/main",
    GITHUB_WORKFLOW_SHA: "f".repeat(40),
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
  };
  return { runRoot, output, env };
}

describe("trusted detached attestation subject", () => {
  it("binds the runtime, configuration, batch, and hosted workflow identity", () => {
    const test = fixture();
    const create = spawnSync(process.execPath, [
      script,
      "--run-root", test.runRoot,
      "--source-root", sourceRoot,
      "--configuration", "configuration.json",
      "--runtime-manifest", "runtime-manifest.json",
      "--out", test.output,
    ], { env: test.env, encoding: "utf8" });
    expect(create.status, create.stderr).toBe(0);
    const subject = JSON.parse(readFileSync(test.output, "utf8"));
    expect(subject).toMatchObject({
      schema: "ax.arena-trusted-run-subject/v1",
      repository: "example/ax-eval",
      source_commit_sha: "a".repeat(40),
      protected_default_branch: "main",
      workflow: { sha: "f".repeat(40), environment: "trusted-sandbox" },
      runtime: {
        lock_sha256: "b".repeat(64),
        container_digest: "sha256:" + "c".repeat(64),
        tools_tree_sha256: "d".repeat(64),
      },
      batch: { id: "batch-1", completed_cells: 1 },
    });
    const verify = spawnSync(process.execPath, [script, "--verify", test.output, "--source-root", sourceRoot], { env: test.env, encoding: "utf8" });
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.stdout).toMatch(/^[a-f0-9]{64}  /);
    const wrongWorkflow = spawnSync(process.execPath, [script, "--verify", test.output, "--source-root", sourceRoot], {
      env: { ...test.env, GITHUB_WORKFLOW_SHA: "0".repeat(40) },
      encoding: "utf8",
    });
    expect(wrongWorkflow.status).not.toBe(0);
    expect(wrongWorkflow.stderr).toContain("does not match the signing workflow");
  });

  it("detects post-seal changes to every referenced artifact", () => {
    for (const name of ["runtime-manifest.json", "configuration.json", "batch.json", "batch-completion.json"]) {
      const test = fixture();
      const create = spawnSync(process.execPath, [
        script,
        "--run-root", test.runRoot,
        "--source-root", sourceRoot,
        "--configuration", "configuration.json",
        "--runtime-manifest", "runtime-manifest.json",
        "--out", test.output,
      ], { env: test.env, encoding: "utf8" });
      expect(create.status, create.stderr).toBe(0);
      writeFileSync(resolve(test.runRoot, name), "{}\n");
      const verify = spawnSync(process.execPath, [script, "--verify", test.output, "--source-root", sourceRoot], { env: test.env, encoding: "utf8" });
      expect(verify.status).not.toBe(0);
      expect(verify.stderr).toContain("does not match its detached attestation hash");
    }
  });
});
