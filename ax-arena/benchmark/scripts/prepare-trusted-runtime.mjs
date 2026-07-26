import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:https";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTrustedRuntime, sha256 } from "./lib/trusted-runtime.mjs";

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const TOOL_ROOT = "/opt/ax-arena-tools";

function allowedRedirect(original, next) {
  if (next.protocol !== "https:") return false;
  if (original.origin === next.origin) return true;
  if (original.hostname === "github.com") {
    return next.hostname === "objects.githubusercontent.com"
      || next.hostname.endsWith(".githubusercontent.com");
  }
  return false;
}

async function download(urlText, destination, redirects = 0, original = new URL(urlText)) {
  if (redirects > 5) throw new Error(`too many redirects downloading ${original}`);
  const url = new URL(urlText);
  if (url.protocol !== "https:") throw new Error(`trusted download requires HTTPS: ${url}`);
  await new Promise((accept, reject) => {
    const request = get(url, { headers: { "user-agent": "ax-arena-trusted-runtime/1" } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        const location = response.headers.location;
        if (!location) return reject(new Error(`redirect without Location from ${url}`));
        const next = new URL(location, url);
        if (!allowedRedirect(original, next)) return reject(new Error(`untrusted redirect from ${original} to ${next}`));
        download(next.href, destination, redirects + 1, original).then(accept, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`download failed with HTTP ${response.statusCode}: ${url}`));
      }
      const declared = Number(response.headers["content-length"] ?? 0);
      if (declared > MAX_DOWNLOAD_BYTES) {
        response.resume();
        return reject(new Error(`trusted download exceeds ${MAX_DOWNLOAD_BYTES} bytes`));
      }
      let received = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) {
          request.destroy(new Error(`trusted download exceeds ${MAX_DOWNLOAD_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          writeFileSync(destination, Buffer.concat(chunks), { flag: "wx", mode: 0o600 });
          accept();
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

function verifyFile(path, expected, label) {
  const actual = sha256(readFileSync(path));
  if (actual !== expected) throw new Error(`${label} SHA-256 mismatch (expected ${expected}, got ${actual})`);
}

function walk(root, current = root, entries = []) {
  for (const name of readdirSync(current).sort()) {
    const path = resolve(current, name);
    const rel = relative(root, path).replaceAll("\\", "/");
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      entries.push({ path: `${rel}/`, type: "directory", mode: stat.mode & 0o777 });
      walk(root, path, entries);
    } else if (stat.isFile()) {
      entries.push({ path: rel, type: "file", mode: stat.mode & 0o777, size: stat.size, sha256: sha256(readFileSync(path)) });
    } else if (stat.isSymbolicLink()) {
      entries.push({ path: rel, type: "symlink", target: readlinkSync(path) });
    } else {
      throw new Error(`trusted tool closure contains an unsupported file type: ${path}`);
    }
  }
  return entries;
}

function sealTree(path) {
  const stat = lstatSync(path);
  if (!stat.isSymbolicLink()) {
    chownSync(path, 0, 0);
    chmodSync(path, stat.isDirectory() ? 0o755 : ((stat.mode & 0o111) ? 0o555 : 0o444));
  }
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) sealTree(resolve(path, name));
  }
}

if (process.platform !== "linux" || process.arch !== "x64" || (process.getuid?.() ?? -1) !== 0) {
  throw new Error("trusted runtime preparation requires root in the locked linux/amd64 container");
}
const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const runtime = readTrustedRuntime(repositoryRoot);
if (process.version !== `v${runtime.lock.container.node_version}`) throw new Error("runtime preparation Node version drifted");
const sysroot = realpathSync(process.env.AX_ARENA_OCI_SYSROOT ?? "");
if (sysroot !== "/opt/ax-arena-runtime/rootfs"
  || realpathSync(resolve(sysroot, "usr/local/bin/node")) !== realpathSync(process.execPath)) {
  throw new Error("runtime preparation must execute with Node from the reviewed OCI sysroot");
}
const outputPath = resolve(process.env.RUNTIME_MANIFEST_PATH ?? "/tmp/ax-arena-runtime-manifest.json");
const toolMarker = resolve(TOOL_ROOT, ".ax-arena-runtime-lock");
try {
  const rootStat = lstatSync(TOOL_ROOT);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || readFileSync(toolMarker, "utf8").trim() !== runtime.sha256) {
    throw new Error("refusing to replace an unrecognized trusted tool directory");
  }
  rmSync(TOOL_ROOT, { recursive: true });
} catch (error) {
  if ((error instanceof Error && "code" in error && error.code === "ENOENT")) {
    try {
      lstatSync(TOOL_ROOT);
      throw new Error("refusing to replace an unrecognized trusted tool directory");
    } catch (nested) {
      if (!(nested instanceof Error && "code" in nested && nested.code === "ENOENT")) throw nested;
    }
  } else {
    throw error;
  }
}
mkdirSync(TOOL_ROOT, { recursive: true, mode: 0o755 });
const scratch = `/tmp/ax-arena-runtime-${randomUUID()}`;
mkdirSync(scratch, { mode: 0o700 });
try {
  const bubblewrapArchive = resolve(scratch, "bubblewrap.deb");
  await download(runtime.lock.bubblewrap.archive_url, bubblewrapArchive);
  verifyFile(bubblewrapArchive, runtime.lock.bubblewrap.archive_sha256, "bubblewrap archive");
  const bubblewrapRoot = resolve(TOOL_ROOT, "bubblewrap");
  mkdirSync(bubblewrapRoot, { recursive: true });
  execFileSync("dpkg-deb", ["--extract", bubblewrapArchive, bubblewrapRoot], { stdio: "inherit" });
  verifyFile(runtime.lock.bubblewrap.executable_path, runtime.lock.bubblewrap.executable_sha256, "bubblewrap executable");

  const harnessRoot = resolve(TOOL_ROOT, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  copyFileSync(resolve(repositoryRoot, "ax-arena/benchmark/trusted-runtime/harness/package.json"), resolve(harnessRoot, "package.json"));
  copyFileSync(resolve(repositoryRoot, runtime.lock.harnesses.package_lock_path), resolve(harnessRoot, "package-lock.json"));
  execFileSync(process.env.npm_execpath ? process.execPath : "npm", process.env.npm_execpath
    ? [process.env.npm_execpath, "ci", "--prefix", harnessRoot, "--ignore-scripts", "--workspaces=false"]
    : ["ci", "--prefix", harnessRoot, "--ignore-scripts", "--workspaces=false"], {
    cwd: repositoryRoot,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
    stdio: "inherit",
  });
  for (const [name, version, installedName] of [
    ["@openai/codex", runtime.lock.harnesses.codex.version],
    ["@anthropic-ai/claude-code", runtime.lock.harnesses.claude_code.version],
    ["@openai/codex", `${runtime.lock.harnesses.codex.version}-linux-x64`, "@openai/codex-linux-x64"],
    ["@anthropic-ai/claude-code-linux-x64", runtime.lock.harnesses.claude_code.version],
  ]) {
    const packageName = installedName ?? name;
    const manifest = JSON.parse(readFileSync(resolve(harnessRoot, "node_modules", ...packageName.split("/"), "package.json"), "utf8"));
    if (manifest.version !== version) throw new Error(`${packageName} installed version drifted`);
  }

  const nodePath = resolve(TOOL_ROOT, "node", "bin", "node");
  mkdirSync(dirname(nodePath), { recursive: true });
  copyFileSync(process.execPath, nodePath);

  const tursoArchive = resolve(scratch, "turso.tar.gz");
  await download(runtime.lock.turso_cli.archive_url, tursoArchive);
  verifyFile(tursoArchive, runtime.lock.turso_cli.archive_sha256, "Turso CLI archive");
  const tursoExtract = resolve(scratch, "turso");
  mkdirSync(tursoExtract);
  execFileSync("tar", ["--extract", "--gzip", "--file", tursoArchive, "--directory", tursoExtract, "turso"], { stdio: "inherit" });
  mkdirSync(dirname(runtime.lock.turso_cli.executable_path), { recursive: true });
  copyFileSync(resolve(tursoExtract, "turso"), runtime.lock.turso_cli.executable_path);
  verifyFile(runtime.lock.turso_cli.executable_path, runtime.lock.turso_cli.executable_sha256, "Turso CLI executable");

  const probeEnv = {
    HOME: scratch,
    PATH: `${resolve(TOOL_ROOT, "node", "bin")}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
  };
  for (const [path, expected, label] of [
    [runtime.lock.harnesses.codex.executable_path, runtime.lock.harnesses.codex.version_output, "Codex"],
    [runtime.lock.harnesses.claude_code.executable_path, runtime.lock.harnesses.claude_code.version_output, "Claude Code"],
    [runtime.lock.turso_cli.executable_path, runtime.lock.turso_cli.version_output, "Turso CLI"],
  ]) {
    const actual = execFileSync(path, ["--version"], {
      encoding: "utf8",
      env: probeEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
    if (actual !== expected) throw new Error(`${label} version output drifted (expected ${expected}, got ${actual})`);
  }

  const etcRoot = resolve(TOOL_ROOT, "etc");
  mkdirSync(etcRoot, { recursive: true });
  for (const name of ["resolv.conf", "hosts", "nsswitch.conf"]) {
    copyFileSync(resolve("/etc", name), resolve(etcRoot, name));
  }
  cpSync(resolve(sysroot, "etc/ssl"), resolve(etcRoot, "ssl"), { recursive: true, dereference: true });

  writeFileSync(toolMarker, `${runtime.sha256}\n`, { flag: "wx", mode: 0o444 });
  sealTree(TOOL_ROOT);
  const entries = walk(TOOL_ROOT);
  const manifest = {
    schema: "ax.arena-trusted-runtime-manifest/v1",
    platform: `${process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`,
    runtime_lock_path: "ax-arena/benchmark/trusted-runtime/runtime-lock.json",
    runtime_lock_sha256: runtime.sha256,
    sysroot: "/opt/ax-arena-runtime/rootfs",
    container: runtime.lock.container,
    node_executable_sha256: sha256(readFileSync(nodePath)),
    tools_tree_sha256: sha256(JSON.stringify(entries)),
    entries,
  };
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444, flag: "wx" });
  chownSync(outputPath, 0, 0);
  chmodSync(outputPath, 0o444);
  process.stdout.write(`${JSON.stringify({ runtime_lock_sha256: runtime.sha256, runtime_manifest_path: outputPath })}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
