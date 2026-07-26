import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ChildProcessSandbox, ChildSandboxInvocation, ChildSandboxProvenance } from "ax-eval";

export const BUBBLEWRAP_POLICY_VERSION = "ax.arena-bubblewrap/v2" as const;
export const BUBBLEWRAP_RUNTIME_ROOTS = ["/usr", "/opt/ax-arena-tools"] as const;
export const BUBBLEWRAP_SANDBOX_ID = "ax-arena-bubblewrap" as const;

export interface BubblewrapSandboxConfig {
  kind: "bubblewrap";
  policy_version: typeof BUBBLEWRAP_POLICY_VERSION;
  runtime_lock_sha256: string;
  sysroot: string;
  executable: string;
  executable_sha256: string;
  runtime_roots: string[];
}

interface SandboxRuntime {
  platform: NodeJS.Platform;
  read(path: string): Buffer;
  realpath(path: string): string;
  stat(path: string): {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mode: number;
    uid: number;
  };
}

const REAL_RUNTIME: SandboxRuntime = {
  platform: process.platform,
  read: readFileSync,
  realpath: realpathSync,
  stat: lstatSync,
};

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
}

function immutableRoot(runtime: SandboxRuntime, path: string, label: string): string {
  const stat = runtime.stat(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} cannot be a symlink`);
  const canonical = runtime.realpath(path);
  const canonicalStat = runtime.stat(canonical);
  if (canonicalStat.uid !== 0 || (canonicalStat.mode & 0o022) !== 0) {
    throw new Error(`${label} must be root-owned and non-writable`);
  }
  return canonical;
}

function policy(config: BubblewrapSandboxConfig): object {
  return {
    version: BUBBLEWRAP_POLICY_VERSION,
    runtime_lock_sha256: config.runtime_lock_sha256,
    sysroot: "/opt/ax-arena-runtime/rootfs",
    executable_sha256: config.executable_sha256,
    runtime_roots: [...BUBBLEWRAP_RUNTIME_ROOTS],
    workspace: "single-cell-read-write",
    host_processes: "hidden-by-new-pid-namespace",
    network: "shared",
    temporary_directory: "private-tmpfs",
    devices: "minimal-bubblewrap-dev",
    capabilities: "dropped",
    environment: "explicit-cell-environment",
  };
}

export function bubblewrapPolicyHash(config: BubblewrapSandboxConfig): string {
  return hash(JSON.stringify(policy(config)));
}

export function buildBubblewrapInvocationWithRuntime(
  config: BubblewrapSandboxConfig,
  command: string,
  args: readonly string[],
  cwd: string,
  runtime: SandboxRuntime,
): { command: string; args: string[]; provenance: ChildSandboxProvenance } {
  if (runtime.platform !== "linux") throw new Error("trusted arena execution requires Linux bubblewrap");
  if (config.kind !== "bubblewrap" || config.policy_version !== BUBBLEWRAP_POLICY_VERSION) {
    throw new Error("unsupported arena sandbox policy");
  }
  for (const [value, label] of [
    [config.runtime_lock_sha256, "runtime lock"],
    [config.executable_sha256, "bubblewrap executable"],
  ] as const) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} requires a full SHA-256 pin`);
  }
  if (!isAbsolute(command)) throw new Error("sandboxed harness command must use an absolute path");

  const executable = immutableRoot(runtime, config.executable, "bubblewrap executable");
  const executableStat = runtime.stat(executable);
  if (!executableStat.isFile() || hash(runtime.read(executable)) !== config.executable_sha256) {
    throw new Error("bubblewrap executable SHA-256 mismatch");
  }
  if (config.sysroot !== "/opt/ax-arena-runtime/rootfs") {
    throw new Error(`${BUBBLEWRAP_POLICY_VERSION} requires the reviewed OCI sysroot path`);
  }
  const sysroot = immutableRoot(runtime, config.sysroot, "OCI sysroot");
  if (!runtime.stat(sysroot).isDirectory() || sysroot !== config.sysroot) {
    throw new Error("OCI sysroot must be a canonical directory");
  }
  const configuredRoots = [...new Set(config.runtime_roots)].sort();
  const expectedRoots = [...BUBBLEWRAP_RUNTIME_ROOTS].sort();
  if (configuredRoots.length !== expectedRoots.length
    || configuredRoots.some((root, index) => root !== expectedRoots[index])) {
    throw new Error(`${BUBBLEWRAP_POLICY_VERSION} requires the exact reviewed runtime roots`);
  }
  const roots = [
    { source: immutableRoot(runtime, resolve(sysroot, "usr"), "OCI /usr runtime root"), target: "/usr" },
    { source: immutableRoot(runtime, "/opt/ax-arena-tools", "trusted tool runtime root"), target: "/opt/ax-arena-tools" },
  ];
  if (roots.some((root) => !runtime.stat(root.source).isDirectory())) {
    throw new Error("sandbox runtime roots must be canonical directories");
  }

  const workspaceStat = runtime.stat(cwd);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error("sandbox workspace must be a real directory");
  }
  const workspace = runtime.realpath(cwd);
  if (roots.some((root) => isInside(root.source, workspace) || isInside(workspace, root.source))) {
    throw new Error("sandbox runtime roots must not overlap the writable workspace");
  }
  const commandStat = runtime.stat(command);
  if (commandStat.isSymbolicLink()) throw new Error("sandboxed harness command cannot be a symlink");
  const commandPath = runtime.realpath(command);
  const canonicalCommandStat = runtime.stat(commandPath);
  if (!canonicalCommandStat.isFile() || canonicalCommandStat.uid !== 0 || (canonicalCommandStat.mode & 0o022) !== 0) {
    throw new Error("sandboxed harness command must be root-owned and non-writable");
  }
  if (!isInside("/opt/ax-arena-tools", commandPath)) {
    throw new Error("sandboxed harness command must resolve inside a reviewed runtime root");
  }

  return {
    command: executable,
    args: [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      "--share-net",
      "--cap-drop", "ALL",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      ...roots.flatMap((root) => ["--ro-bind", root.source, root.target]),
      "--dir", "/etc",
      "--ro-bind", "/opt/ax-arena-tools/etc/resolv.conf", "/etc/resolv.conf",
      "--ro-bind", "/opt/ax-arena-tools/etc/hosts", "/etc/hosts",
      "--ro-bind", "/opt/ax-arena-tools/etc/nsswitch.conf", "/etc/nsswitch.conf",
      "--ro-bind", "/opt/ax-arena-tools/etc/ssl", "/etc/ssl",
      "--symlink", "usr/bin", "/bin",
      "--symlink", "usr/sbin", "/sbin",
      "--symlink", "usr/lib", "/lib",
      "--symlink", "usr/lib64", "/lib64",
      "--bind", workspace, workspace,
      "--chdir", workspace,
      "--",
      commandPath,
      ...args,
    ],
    provenance: {
      id: BUBBLEWRAP_SANDBOX_ID,
      version: BUBBLEWRAP_POLICY_VERSION,
      implementation_sha256: config.executable_sha256,
      policy_sha256: bubblewrapPolicyHash(config),
    },
  };
}

export function buildBubblewrapInvocation(
  config: BubblewrapSandboxConfig,
  command: string,
  args: readonly string[],
  cwd: string,
) {
  return buildBubblewrapInvocationWithRuntime(config, command, args, cwd, REAL_RUNTIME);
}

export function createBubblewrapSandbox(config: BubblewrapSandboxConfig): ChildProcessSandbox {
  const snapshot = Object.freeze(structuredClone(config));
  return Object.freeze({
    wrap(invocation: ChildSandboxInvocation) {
      return buildBubblewrapInvocation(snapshot, invocation.command, invocation.args, invocation.cwd);
    },
  });
}
