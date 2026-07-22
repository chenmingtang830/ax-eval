import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRuntimeLock, readTrustedRuntime } from "../scripts/lib/trusted-runtime.mjs";

const repositoryRoot = resolve(process.cwd(), "../..");

describe("trusted runtime lock and workflow", () => {
  it("ships an exact OCI, harness, Bubblewrap, and Turso closure", () => {
    const runtime = readTrustedRuntime(repositoryRoot);
    expect(runtime.lock).toMatchObject({
      schema: "ax.arena-trusted-runtime-lock/v1",
      platform: "linux/amd64",
      container: {
        image: "docker.io/library/node:22.23.1-bookworm",
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        node_version: "22.23.1",
      },
      harnesses: {
        codex: { version: "0.145.0", version_output: "codex-cli 0.145.0" },
        claude_code: { version: "2.1.217", version_output: "2.1.217 (Claude Code)" },
      },
      bubblewrap: {
        archive_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        executable_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      turso_cli: {
        version: "1.0.30",
        archive_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        executable_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(runtime.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(runtime.lock.harnesses.package_lock_sha256).toBe("b3b39718c28214818682a352db6be6f8f216ea44e191d60c11ade74a853752ac");
  });

  it("rejects mutable release aliases and malformed runtime pins", () => {
    const lock = JSON.parse(readFileSync(resolve(repositoryRoot, "ax-arena/benchmark/trusted-runtime/runtime-lock.json"), "utf8"));
    expect(() => parseRuntimeLock({
      ...lock,
      bubblewrap: { ...lock.bubblewrap, archive_url: "https://example.invalid/latest/bubblewrap.deb" },
    })).toThrow(/mutable release alias/);
    expect(() => parseRuntimeLock({
      ...lock,
      container: { ...lock.container, digest: "sha256:short" },
    })).toThrow(/container digest is invalid/);
    expect(() => parseRuntimeLock({
      ...lock,
      harnesses: { ...lock.harnesses, package_lock_sha256: "0".repeat(63) },
    })).toThrow(/package-lock hash is invalid/);
  });

  it("keeps credentialed execution after verified sysroot preparation and signing in a separate job", () => {
    const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/trusted-sandbox-records.yml"), "utf8");
    const preparation = readFileSync(resolve(repositoryRoot, "ax-arena/benchmark/scripts/prepare-trusted-tools.sh"), "utf8");
    const runtime = readTrustedRuntime(repositoryRoot);
    const image = `${runtime.lock.container.image}@${runtime.lock.container.digest}`;
    expect(workflow).toContain(`TRUSTED_CONTAINER_IMAGE: ${image}`);
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("prepare-trusted-tools.sh");
    expect(preparation).toContain("prepare-trusted-sysroot.sh");
    expect(preparation).toContain("sudo --preserve-env");
    expect(workflow).toContain("node-version: \"22.23.1\"");
    expect(preparation).toContain('npm" ci --ignore-scripts');
    expect(workflow).not.toContain("seccomp=unconfined");
    expect(workflow).not.toContain("--privileged");
    expect(workflow).not.toContain("ubuntu-latest");
    expect(workflow).not.toContain("apt-get");
    expect(workflow).not.toContain("npm install --global");
    expect(workflow).toContain("approved-self-hosted");
    expect(workflow).toContain('"group":"ax-arena-trusted"');
    expect(workflow).toContain("sudo install -o root -g root -m 0444");
    expect(workflow).toContain("export-trusted-run.mjs");
    expect(workflow).toContain("path: ${{ runner.temp }}/trusted-arena-export-");
    expect(workflow).not.toContain("path: results/runs/trusted-");
    const prepare = workflow.indexOf("prepare-trusted-tools.sh");
    const firstSecret = workflow.indexOf("secrets.");
    expect(prepare).toBeGreaterThan(0);
    expect(firstSecret).toBeGreaterThan(prepare);
    const cohortStart = workflow.indexOf("  cohort:");
    const attestStart = workflow.indexOf("  attest:");
    expect(workflow.slice(cohortStart, attestStart)).not.toContain("id-token: write");
    expect(workflow.slice(cohortStart, attestStart)).not.toContain("attestations: write");
    expect(workflow.slice(attestStart)).toContain("id-token: write");
    expect(workflow.slice(attestStart)).toContain("environment: trusted-sandbox");
    expect(workflow.slice(attestStart)).toContain("vars.AX_ARENA_APPROVED_SIGNER_SHA");
    expect(workflow.slice(attestStart)).not.toContain("secrets.");
    const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((use) => /@[a-f0-9]{40}$/.test(use!))).toBe(true);
  });

  it("revalidates Docker's digest cache and exports a fresh non-writable sysroot", () => {
    const source = readFileSync(resolve(repositoryRoot, "ax-arena/benchmark/scripts/prepare-trusted-sysroot.sh"), "utf8");
    expect(source).toContain('docker pull "$TRUSTED_CONTAINER_IMAGE"');
    expect(source).toContain("docker create --platform linux/amd64");
    expect(source).toContain("docker export");
    expect(source).toContain("sudo chown -R root:root");
    expect(source).toContain("sudo chmod -R go-w");
    expect(source.indexOf('docker pull "$TRUSTED_CONTAINER_IMAGE"')).toBeLessThan(source.indexOf("docker export"));
    expect(source).toContain("AX_ARENA_SELF_HOSTED_APPROVED");
    expect(source).not.toContain("latest");
  });
});
