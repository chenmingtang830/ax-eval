import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTrustedRuntime } from "./lib/trusted-runtime.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const runtime = readTrustedRuntime(repositoryRoot);
const { buildBubblewrapInvocation } = await import("../dist/index.js");
const workspace = mkdtempSync(resolve(tmpdir(), "ax-arena-sandbox-smoke-"));
try {
  const invocation = buildBubblewrapInvocation({
    kind: "bubblewrap",
    policy_version: "ax.arena-bubblewrap/v2",
    runtime_lock_sha256: runtime.sha256,
    sysroot: "/opt/ax-arena-runtime/rootfs",
    executable: runtime.lock.bubblewrap.executable_path,
    executable_sha256: runtime.lock.bubblewrap.executable_sha256,
    runtime_roots: ["/usr", "/opt/ax-arena-tools"],
  }, "/opt/ax-arena-tools/node/bin/node", [
    "--input-type=module",
    "--eval",
    [
      "import {readFileSync,writeFileSync} from 'node:fs'",
      "import {spawnSync} from 'node:child_process'",
      "if(readFileSync('/proc/1/environ').includes('AX_ARENA_PARENT_SECRET')) process.exit(11)",
      "writeFileSync('sandbox-smoke.txt','ok')",
      "if(spawnSync('/bin/sh',['-c','test -x /bin/sh && test -x /bin/bash']).status!==0) process.exit(12)",
      "const response=await fetch('https://registry.npmjs.org/-/ping')",
      "if(!response.ok) process.exit(13)",
    ].join(";"),
  ], workspace);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: workspace,
    encoding: "utf8",
    env: {
      HOME: workspace,
      PATH: "/opt/ax-arena-tools/node/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
    },
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`trusted sandbox smoke failed (${result.status}): ${result.stderr}`);
  }
  process.stdout.write("trusted runtime sandbox smoke passed\n");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
