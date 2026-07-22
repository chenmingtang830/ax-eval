import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BUBBLEWRAP_POLICY_VERSION,
  buildBubblewrapInvocationWithRuntime,
  type BubblewrapSandboxConfig,
} from "../src/controller/sandbox.js";

const executableBytes = Buffer.from("pinned bubblewrap fixture");
const executableSha = createHash("sha256").update(executableBytes).digest("hex");
const bubblewrap = "/opt/ax-arena-tools/bubblewrap/usr/bin/bwrap";
const harnessCommand = "/opt/ax-arena-tools/harness/node_modules/@openai/codex/bin/codex.js";
const sysroot = "/opt/ax-arena-runtime/rootfs";

function config(overrides: Partial<BubblewrapSandboxConfig> = {}): BubblewrapSandboxConfig {
  return {
    kind: "bubblewrap",
    policy_version: BUBBLEWRAP_POLICY_VERSION,
    runtime_lock_sha256: "7".repeat(64),
    sysroot,
    executable: bubblewrap,
    executable_sha256: executableSha,
    runtime_roots: ["/usr", "/opt/ax-arena-tools"],
    ...overrides,
  };
}

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    platform: "linux" as const,
    read: () => executableBytes,
    realpath: (path: string) => path,
    stat: (path: string) => ({
      isFile: () => path === bubblewrap || path === harnessCommand,
      isDirectory: () => path !== bubblewrap && path !== harnessCommand,
      isSymbolicLink: () => false,
      mode: path === bubblewrap || path === harnessCommand ? 0o100555 : 0o040755,
      uid: 0,
    }),
    ...overrides,
  };
}

describe("trusted Bubblewrap policy", () => {
  it("maps the verified OCI sysroot read-only and exposes only one writable workspace", () => {
    const first = buildBubblewrapInvocationWithRuntime(
      config(), harnessCommand, ["exec", "prompt"], "/work/cell", runtime(),
    );
    const second = buildBubblewrapInvocationWithRuntime(
      config(), harnessCommand, ["exec", "prompt"], "/work/cell", runtime(),
    );

    expect(first.command).toBe(bubblewrap);
    expect(first.args).toEqual(expect.arrayContaining([
      "--unshare-user",
      "--unshare-pid",
      "--share-net",
      "--cap-drop", "ALL",
      "--ro-bind", `${sysroot}/usr`, "/usr",
      "--ro-bind", "/opt/ax-arena-tools", "/opt/ax-arena-tools",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      "--bind", "/work/cell", "/work/cell",
      "--chdir", "/work/cell",
    ]));
    expect(first.args.slice(-3)).toEqual([harnessCommand, "exec", "prompt"]);
    expect(first.args).not.toContain("/home");
    expect(first.args).not.toContain("/run");
    expect(first.provenance).toEqual(second.provenance);
    expect(first.provenance).toMatchObject({
      id: "ax-arena-bubblewrap",
      version: BUBBLEWRAP_POLICY_VERSION,
      implementation_sha256: executableSha,
    });
    expect(first.provenance.policy_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects runtime drift, writable roots, path overlap, and non-Linux execution", () => {
    expect(() => buildBubblewrapInvocationWithRuntime(
      config({ executable_sha256: "0".repeat(64) }), harnessCommand, [], "/work/cell", runtime(),
    )).toThrow(/SHA-256 mismatch/);
    expect(() => buildBubblewrapInvocationWithRuntime(
      config({ sysroot: "/tmp/rootfs" }), harnessCommand, [], "/work/cell", runtime(),
    )).toThrow(/reviewed OCI sysroot path/);
    expect(() => buildBubblewrapInvocationWithRuntime(
      config(), harnessCommand, [], "/work/cell", runtime({
        stat: (path: string) => ({
          isFile: () => path === bubblewrap || path === harnessCommand,
          isDirectory: () => path !== bubblewrap && path !== harnessCommand,
          isSymbolicLink: () => false,
          mode: path === `${sysroot}/usr` ? 0o040777 : path === bubblewrap || path === harnessCommand ? 0o100555 : 0o040755,
          uid: 0,
        }),
      }),
    )).toThrow(/root-owned and non-writable/);
    expect(() => buildBubblewrapInvocationWithRuntime(
      config(), harnessCommand, [], `${sysroot}/usr/work`, runtime(),
    )).toThrow(/must not overlap/);
    expect(() => buildBubblewrapInvocationWithRuntime(
      config({ runtime_roots: ["/usr"] }), harnessCommand, [], "/work/cell", runtime(),
    )).toThrow(/exact reviewed runtime roots/);
    expect(() => buildBubblewrapInvocationWithRuntime(
      config(), "/work/cell/codex", [], "/work/cell", runtime(),
    )).toThrow(/root-owned and non-writable|reviewed runtime root/);
    expect(() => buildBubblewrapInvocationWithRuntime(
      config(), harnessCommand, [], "/work/cell", runtime({ platform: "darwin" }),
    )).toThrow(/requires Linux/);
  });
});
