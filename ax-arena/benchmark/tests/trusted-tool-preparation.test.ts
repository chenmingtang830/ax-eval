import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd(), "../..");

describe("trusted tool preparation launcher", () => {
  it("uses the verified sysroot Node and exact locks before tool sealing", () => {
    const source = readFileSync(resolve(repositoryRoot, "ax-arena/benchmark/scripts/prepare-trusted-tools.sh"), "utf8");
    const sysroot = source.indexOf('sh "$script_dir/prepare-trusted-sysroot.sh"');
    const install = source.indexOf('npm" ci --ignore-scripts');
    const build = source.indexOf('npm" run build');
    const tools = source.indexOf('"$script_dir/prepare-trusted-runtime.mjs"');
    expect(sysroot).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(sysroot);
    expect(build).toBeGreaterThan(install);
    expect(tools).toBeGreaterThan(build);
    expect(source).toContain("trusted_sysroot=/opt/ax-arena-runtime/rootfs");
    expect(source).toContain('PATH="$trusted_node_bin:/usr/bin:/bin"');
    expect(source).toContain("--preserve-env=AX_ARENA_OCI_SYSROOT,RUNTIME_MANIFEST_PATH");
    expect(source).not.toContain("apt-get");
    expect(source).not.toContain("npm install --global");
    expect(source).not.toContain("seccomp=unconfined");
    expect(source).not.toContain("--privileged");
  });
});
