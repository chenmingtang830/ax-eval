import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const attestationScript = resolve(process.cwd(), "scripts", "trusted-attestation.mjs");
const exportScript = resolve(process.cwd(), "scripts", "export-trusted-run.mjs");
const sourceRoot = resolve(process.cwd(), "../..");
const canonical = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "ax-trusted-export-"));
  const runRoot = resolve(root, "run");
  mkdirSync(runRoot);
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
  const cellRoot = "cells/neon/api/codex/trial-1";
  const files = new Map<string, string>([
    [`${cellRoot}/record.normalized.json`, canonical({ record: "safe" })],
    [`${cellRoot}/cleanup.json`, canonical({ cleanup: "safe" })],
    [`${cellRoot}/workspace/artifacts/invoke.json`, canonical({ invoke: "safe" })],
    [`${cellRoot}/workspace/artifacts/results.json`, canonical({ results: "safe" })],
    [`${cellRoot}/workspace/artifacts/trace.json`, canonical([{ step: 1 }])],
    [`${cellRoot}/workspace/artifacts/transcript.jsonl`, "safe transcript\n"],
  ]);
  for (const [path, bytes] of files) {
    const absolute = resolve(runRoot, path);
    mkdirSync(resolve(absolute, ".."), { recursive: true });
    writeFileSync(absolute, bytes);
  }
  const completion = {
    schema: "ax.arena-batch-completion/v1",
    batch_id: "batch-1",
    source_commit_sha: source,
    configuration_hash: "e".repeat(64),
    runtime_manifest_sha256: sha256(canonical(runtimeManifest)),
    completed_at: "2026-07-22T00:00:00.000Z",
    cells: [{
      key: "neon/api/codex/trial-1",
      record_path: `${cellRoot}/record.normalized.json`,
      record_hash: sha256(files.get(`${cellRoot}/record.normalized.json`)! ),
      cleanup_path: `${cellRoot}/cleanup.json`,
      cleanup_hash: sha256(files.get(`${cellRoot}/cleanup.json`)! ),
      artifacts: [
        ["invoke_metadata", "invoke.json"],
        ["results", "results.json"],
        ["trace", "trace.json"],
        ["transcript", "transcript.jsonl"],
      ].map(([name, file]) => ({
        name,
        path: `${cellRoot}/workspace/artifacts/${file}`,
        sha256: sha256(files.get(`${cellRoot}/workspace/artifacts/${file}`)! ),
      })),
    }],
  };
  for (const [name, value] of [
    ["configuration.json", configuration],
    ["runtime-manifest.json", runtimeManifest],
    ["batch.json", batch],
    ["batch-completion.json", completion],
  ] as const) writeFileSync(resolve(runRoot, name), canonical(value));
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
  const subjectPath = resolve(runRoot, "trusted-run-subject.json");
  const create = spawnSync(process.execPath, [
    attestationScript,
    "--run-root", runRoot,
    "--source-root", sourceRoot,
    "--configuration", "configuration.json",
    "--runtime-manifest", "runtime-manifest.json",
    "--out", subjectPath,
  ], { env, encoding: "utf8" });
  expect(create.status, create.stderr).toBe(0);
  return { root, runRoot, cellRoot, files, env };
}

describe("trusted run exporter", () => {
  it("copies only subject-bound completion artifacts and never follows workspace links", () => {
    const test = fixture();
    const writableWorkspace = resolve(test.runRoot, test.cellRoot, "workspace");
    writeFileSync(resolve(writableWorkspace, "credential-leak.txt"), "OPENAI_API_KEY=secret\n");
    symlinkSync("/etc/passwd", resolve(writableWorkspace, "host-passwd"));
    const output = resolve(test.root, "export");
    const exported = spawnSync(process.execPath, [
      exportScript, "--run-root", test.runRoot, "--out", output,
    ], { env: test.env, encoding: "utf8" });
    expect(exported.status, exported.stderr).toBe(0);
    const exportedFiles = readdirSync(output, { recursive: true })
      .map(String)
      .filter((path) => {
        try { return readFileSync(resolve(output, path)).length >= 0; } catch { return false; }
      })
      .sort();
    expect(exportedFiles).toContain("trusted-run-subject.json");
    expect(exportedFiles).toContain(`${test.cellRoot}/record.normalized.json`);
    expect(exportedFiles).toContain(`${test.cellRoot}/workspace/artifacts/transcript.jsonl`);
    expect(exportedFiles).not.toContain(`${test.cellRoot}/workspace/credential-leak.txt`);
    expect(exportedFiles).not.toContain(`${test.cellRoot}/workspace/host-passwd`);
    expect(exportedFiles).toHaveLength(11);
  });

  it("rejects a sealed file changed after subject creation", () => {
    const test = fixture();
    writeFileSync(resolve(test.runRoot, test.cellRoot, "record.normalized.json"), "{}\n");
    const exported = spawnSync(process.execPath, [
      exportScript, "--run-root", test.runRoot, "--out", resolve(test.root, "export"),
    ], { env: test.env, encoding: "utf8" });
    expect(exported.status).not.toBe(0);
    expect(exported.stderr).toContain("sealed SHA-256");
  });
});
