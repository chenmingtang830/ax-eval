import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ChildProcessSandbox, ChildSandboxInvocation } from "ax-eval";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function quoteSeatbelt(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * Local V2.2 runs use live credentials and must never let a harness write into
 * the checkout. macOS Seatbelt keeps network and read access available for
 * discovery while granting writes only under the controller-created cell root.
 */
export function createMacOsWorkspaceWriteSandbox(options: {
  writableRoot: string;
  /** A controller-owned runtime scratch directory required by a harness. */
  temporaryWritableRoot?: string;
  platform?: NodeJS.Platform;
  executable?: string;
}): ChildProcessSandbox {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error("local workspace-write sandbox requires macOS Seatbelt");
  }
  const executable = options.executable ?? SANDBOX_EXEC;
  if (!existsSync(executable)) throw new Error(`missing macOS Seatbelt executable: ${executable}`);
  const writableRoot = realpathSync(options.writableRoot);
  const temporaryWritableRoot = options.temporaryWritableRoot
    ? realpathSync(options.temporaryWritableRoot)
    : undefined;
  const policy = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow file-read*)",
    "(allow network*)",
    `(allow file-write* (subpath \"${quoteSeatbelt(writableRoot)}\"))`,
    ...(temporaryWritableRoot
      ? [`(allow file-write* (subpath \"${quoteSeatbelt(temporaryWritableRoot)}\"))`]
      : []),
  ].join("\n");
  const provenance = {
    id: "macos-seatbelt-workspace-write",
    version: "1",
    implementation_sha256: createHash("sha256")
      .update(createMacOsWorkspaceWriteSandbox.toString())
      .digest("hex"),
    policy_sha256: createHash("sha256").update(policy).digest("hex"),
  };
  return Object.freeze({
    wrap(invocation: ChildSandboxInvocation) {
      const cwd = realpathSync(resolve(invocation.cwd));
      if (!inside(writableRoot, cwd)) {
        throw new Error(`sandbox cwd escapes writable root: ${cwd}`);
      }
      return {
        command: executable,
        args: ["-p", policy, invocation.command, ...invocation.args],
        provenance,
      };
    },
  });
}
