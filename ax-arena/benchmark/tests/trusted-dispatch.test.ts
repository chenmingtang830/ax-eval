import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd(), "../..");
const validator = resolve(process.cwd(), "scripts", "validate-trusted-dispatch.mjs");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root: string, message: string): string {
  git(root, ["add", "."]);
  git(root, [
    "-c", "commit.gpgsign=false",
    "-c", "user.name=AX Test",
    "-c", "user.email=ax@example.invalid",
    "commit", "--quiet", "-m", message,
  ]);
  return git(root, ["rev-parse", "HEAD"]);
}

function fixture(mainTrustDrift: false | "package" | "removed-tsup-config" = false) {
  const root = mkdtempSync(resolve(tmpdir(), "ax-trusted-dispatch-"));
  const daeb = resolve(root, "ax-arena", "benchmark", "daeb", "v1");
  const packDir = resolve(daeb, "packs", "neon");
  const runtimeDir = resolve(root, "ax-arena", "benchmark", "trusted-runtime");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(resolve(runtimeDir, "harness"), { recursive: true });
  cpSync(resolve(repositoryRoot, "ax-arena/benchmark/trusted-runtime/runtime-lock.json"), resolve(runtimeDir, "runtime-lock.json"));
  cpSync(resolve(repositoryRoot, "ax-arena/benchmark/trusted-runtime/harness/package.json"), resolve(runtimeDir, "harness/package.json"));
  cpSync(resolve(repositoryRoot, "ax-arena/benchmark/trusted-runtime/harness/package-lock.json"), resolve(runtimeDir, "harness/package-lock.json"));
  writeFileSync(resolve(root, "package.json"), "{}\n");
  writeFileSync(resolve(root, "package-lock.json"), "{}\n");
  if (mainTrustDrift === "removed-tsup-config") {
    writeFileSync(resolve(root, "tsup.config.ts"), "throw new Error('historical build drift');\n");
  }
  const suite = "name: DAEB-1\nversion: 1\ncategory: database\ntasks: []\n";
  const pack = "name: neon\nstandard_set_version: database-v1\nbase_url: https://example.invalid\ntasks: []\n";
  writeFileSync(resolve(daeb, "suite.yaml"), suite);
  writeFileSync(resolve(packDir, "pack.yaml"), pack);
  writeFileSync(resolve(packDir, "pack.approval.json"), `${JSON.stringify({
    standard_set_version: "database-v1",
    content_hash: "0".repeat(16),
    pack_file_hash: sha256(pack),
    approved_by: "AX Test",
    approved_at: "2026-07-22T00:00:00.000Z",
    task_count: 1,
  }, null, 2)}\n`);
  const runtimeBytes = readFileSync(resolve(runtimeDir, "runtime-lock.json"));
  const runtime = JSON.parse(runtimeBytes.toString("utf8"));
  const configurationPath = resolve(daeb, "trusted-neon-api.json");
  const cell = (harness: "codex" | "claude-code") => ({
    key: `neon/api/${harness}/trial-1`,
    vendor: "neon",
    surface: "api",
    harness,
    profile: "high",
    effort: "high",
    model: harness === "codex" ? "gpt-5.6-terra" : "claude-sonnet-5",
    trial: 1,
    host_credential_names: [harness === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"],
    verification_credential_names: [],
    reset_credential_names: [],
    sandbox_scope_names: [],
    provider_pins: [],
    reset_provider: { id: "fixture-reset", version: "1.0.0" },
  });
  const configuration = {
    command: "daeb-production-rerun",
    execution: { runtime_backend: "pinned-oci", trust_level: "hosted-trusted" },
    reset_required: true,
    suite: { name: "DAEB-1", version: 1, file_hash: sha256(suite) },
    packs: [{
      vendor: "neon",
      file_hash: sha256(pack),
      standard_set_version: "database-v1",
      surfaces: ["api"],
      host_credential_names: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
      verification_credential_names: [],
      reset_credential_names: [],
      sandbox_scope_names: [],
    }],
    cells: [cell("codex"), cell("claude-code")],
    harnesses: [
      {
        harness: "codex",
        version_semver: runtime.harnesses.codex.version,
        version_raw: runtime.harnesses.codex.version_output,
      },
      {
        harness: "claude-code",
        version_semver: runtime.harnesses.claude_code.version,
        version_raw: runtime.harnesses.claude_code.version_output,
      },
    ],
    invoke_timeout_seconds: 900,
    first_action_timeout_seconds: 240,
    invoke_retries: 0,
    sandbox: {
      kind: "bubblewrap",
      policy_version: "ax.arena-bubblewrap/v2",
      runtime_lock_sha256: sha256(runtimeBytes),
      sysroot: "/opt/ax-arena-runtime/rootfs",
      executable: runtime.bubblewrap.executable_path,
      executable_sha256: runtime.bubblewrap.executable_sha256,
      runtime_roots: ["/usr", "/opt/ax-arena-tools"],
    },
  };
  writeFileSync(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`);
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  const sourceSha = commit(root, "protected source");
  writeFileSync(resolve(root, "later-main-note.txt"), "protected descendant\n");
  if (mainTrustDrift === "package") writeFileSync(resolve(root, "package.json"), "{\"drift\":true}\n");
  if (mainTrustDrift === "removed-tsup-config") {
    execFileSync("git", ["rm", "--quiet", "tsup.config.ts"], { cwd: root });
  }
  commit(root, "protected main descendant");
  git(root, ["checkout", "--quiet", "--detach", sourceSha]);
  const env = {
    ...process.env,
    SOURCE_SHA: sourceSha,
    PROTECTED_DEFAULT_BRANCH: "main",
    PROTECTED_DEFAULT_REF: "refs/heads/main",
    CONFIGURATION_PATH: configurationPath,
    EXPECTED_VENDOR: "neon",
    EXPECTED_SURFACE: "api",
    TRUSTED_CONTAINER_IMAGE: `${runtime.container.image}@${runtime.container.digest}`,
  };
  return { root, configurationPath, configuration, sourceSha, env };
}

describe("trusted dispatch validator", () => {
  it("accepts an exact source SHA ancestral to protected main with current trust anchors", () => {
    const test = fixture();
    const result = spawnSync(process.execPath, [validator], { cwd: test.root, env: test.env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      source_sha: test.sourceSha,
      protected_default_branch: "main",
      runtime_lock_sha256: test.configuration.sandbox.runtime_lock_sha256,
    });
  });

  it("rejects a checked-out SHA that diverges from protected main", () => {
    const test = fixture();
    writeFileSync(resolve(test.root, "divergent.txt"), "not merged\n");
    const divergent = commit(test.root, "divergent source");
    const result = spawnSync(process.execPath, [validator], {
      cwd: test.root,
      env: { ...test.env, SOURCE_SHA: divergent },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ancestral to protected main");
  });

  it("rejects protected descendants that changed trust-critical runtime code or locks", () => {
    const test = fixture("package");
    const result = spawnSync(process.execPath, [validator], { cwd: test.root, env: test.env, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("trust");
  });

  it("rejects a historical build config even when protected main removed it", () => {
    const test = fixture("removed-tsup-config");
    const result = spawnSync(process.execPath, [validator], { cwd: test.root, env: test.env, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("trust");
  });

  it("rejects a workflow image that differs from the reviewed digest", () => {
    const test = fixture();
    const result = spawnSync(process.execPath, [validator], {
      cwd: test.root,
      env: { ...test.env, TRUSTED_CONTAINER_IMAGE: "docker.io/library/node:22.23.1-bookworm@sha256:" + "0".repeat(64) },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("workflow container does not match");
  });
});
