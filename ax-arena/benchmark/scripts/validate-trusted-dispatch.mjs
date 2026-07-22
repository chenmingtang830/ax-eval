import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { readTrustedRuntime } from "./lib/trusted-runtime.mjs";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`trusted dispatch requires ${name}`);
  return value;
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, candidate) => {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
};
const git = (root, args, options = {}) => execFileSync("git", args, {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  ...options,
}).trim();
const committedBytes = (root, sha, path, label) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !inside(root, path)) {
    throw new Error(`${label} is not a single-linked repository file`);
  }
  const bytes = readFileSync(path);
  const relativePath = relative(root, path).replaceAll("\\", "/");
  const committed = execFileSync("git", ["show", `${sha}:${relativePath}`], {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!bytes.equals(committed)) throw new Error(`${label} does not match the protected source commit`);
  return bytes;
};
const yamlScalar = (bytes, name) => {
  const match = bytes.toString("utf8").match(new RegExp(`^${name}:\\s*([^\\n#]+)`, "m"));
  if (!match) throw new Error(`canonical YAML is missing ${name}`);
  return match[1].trim().replace(/^(?:"(.*)"|'(.*)')$/, "$1$2");
};
const exactSet = (actual, expected) => Array.isArray(actual)
  && actual.length === expected.length
  && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);

const root = realpathSync(git(process.cwd(), ["rev-parse", "--show-toplevel"]));
const sourceSha = required("SOURCE_SHA");
if (!/^[a-f0-9]{40}$/.test(sourceSha) || sourceSha !== git(root, ["rev-parse", "HEAD"])) {
  throw new Error("trusted dispatch source must be the full checked-out SHA-1 commit ID");
}
if (git(root, ["cat-file", "-t", sourceSha]) !== "commit") throw new Error("trusted source is not a commit object");

const defaultBranch = required("PROTECTED_DEFAULT_BRANCH");
if (defaultBranch !== "main") {
  throw new Error("trusted dispatch requires protected main");
}
const defaultRef = process.env.PROTECTED_DEFAULT_REF?.trim() || `refs/remotes/origin/${defaultBranch}`;
if (git(root, ["cat-file", "-t", defaultRef]) !== "commit") throw new Error("protected default branch ref is not a commit");
const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", sourceSha, defaultRef], {
  cwd: root,
  stdio: "ignore",
});
if (ancestry.status !== 0) throw new Error("trusted source must be ancestral to protected main");

const trustAnchors = [
  ".github/workflows/trusted-sandbox-records.yml",
  "package.json",
  "package-lock.json",
  "src",
  "schemas",
  "ax-arena/benchmark/package.json",
  "ax-arena/benchmark/src",
  "ax-arena/benchmark/schemas",
  "ax-arena/benchmark/scripts",
  "ax-arena/benchmark/trusted-runtime",
];
const anchorDiff = spawnSync("git", ["diff", "--quiet", sourceSha, defaultRef, "--", ...trustAnchors], {
  cwd: root,
  stdio: "ignore",
});
if (anchorDiff.status !== 0) {
  throw new Error("trusted runtime code and locks must match the protected default branch tip");
}
const dirty = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...trustAnchors], {
  cwd: root,
  encoding: "buffer",
  stdio: ["ignore", "pipe", "pipe"],
});
if (dirty.length) throw new Error("trusted runtime code and locks must have a clean worktree");

const runtime = readTrustedRuntime(root);
committedBytes(root, sourceSha, runtime.lockPath, "trusted runtime lock");
committedBytes(root, sourceSha, resolve(root, runtime.lock.harnesses.package_lock_path), "trusted harness package lock");
const expectedImage = `${runtime.lock.container.image}@${runtime.lock.container.digest}`;
if (required("TRUSTED_CONTAINER_IMAGE") !== expectedImage) {
  throw new Error("workflow container does not match the reviewed runtime lock digest");
}
const configurationPath = realpathSync(resolve(root, required("CONFIGURATION_PATH")));
const daebRoot = resolve(root, "ax-arena", "benchmark", "daeb");
if (!inside(daebRoot, configurationPath)) throw new Error("trusted configuration must live under the canonical DAEB root");
const configuration = JSON.parse(committedBytes(root, sourceSha, configurationPath, "batch configuration").toString("utf8"));
const vendor = required("EXPECTED_VENDOR");
const surface = required("EXPECTED_SURFACE");
if (configuration.command !== "daeb-production-rerun"
  || configuration.execution?.runtime_backend !== "pinned-oci"
  || configuration.execution?.trust_level !== "hosted-trusted"
  || configuration.reset_required !== true
  || !Array.isArray(configuration.cells) || configuration.cells.length === 0
  || configuration.cells.some((cell) => cell?.vendor !== vendor || cell?.surface !== surface)) {
  throw new Error("trusted configuration must contain one cleanup-required production vendor/surface cohort");
}
const expectedHarnesses = {
  codex: runtime.lock.harnesses.codex,
  "claude-code": runtime.lock.harnesses.claude_code,
};
if (!Array.isArray(configuration.harnesses) || configuration.harnesses.length !== 2
  || configuration.harnesses.some((pin) => !expectedHarnesses[pin?.harness]
    || pin.version_semver !== expectedHarnesses[pin.harness].version
    || pin.version_raw !== expectedHarnesses[pin.harness].version_output)) {
  throw new Error("trusted harness pins do not match the reviewed dependency lock");
}
const sandbox = configuration.sandbox;
if (sandbox?.kind !== "bubblewrap" || sandbox?.policy_version !== "ax.arena-bubblewrap/v2"
  || sandbox?.runtime_lock_sha256 !== runtime.sha256
  || sandbox?.sysroot !== "/opt/ax-arena-runtime/rootfs"
  || sandbox?.executable !== runtime.lock.bubblewrap.executable_path
  || sandbox?.executable_sha256 !== runtime.lock.bubblewrap.executable_sha256
  || !exactSet(sandbox?.runtime_roots, ["/usr", "/opt/ax-arena-tools"])) {
  throw new Error("trusted sandbox policy does not match the reviewed runtime lock");
}

const suiteBytes = committedBytes(root, sourceSha, resolve(daebRoot, "v1", "suite.yaml"), "canonical suite");
if (configuration.suite?.name !== yamlScalar(suiteBytes, "name")
  || configuration.suite?.version !== Number(yamlScalar(suiteBytes, "version"))
  || configuration.suite?.file_hash !== sha256(suiteBytes)) {
  throw new Error("trusted suite identity does not match the committed configuration");
}
const packPath = resolve(daebRoot, "v1", "packs", vendor, "pack.yaml");
const packBytes = committedBytes(root, sourceSha, packPath, "canonical pack");
const approval = JSON.parse(committedBytes(
  root,
  sourceSha,
  packPath.replace(/\.ya?ml$/i, ".approval.json"),
  "canonical pack approval",
).toString("utf8"));
const configuredPacks = configuration.packs;
if (!Array.isArray(configuredPacks) || configuredPacks.length !== 1 || configuredPacks[0]?.vendor !== vendor
  || configuredPacks[0]?.file_hash !== sha256(packBytes)
  || configuredPacks[0]?.standard_set_version !== yamlScalar(packBytes, "standard_set_version")
  || yamlScalar(packBytes, "name") !== vendor
  || approval?.standard_set_version !== configuredPacks[0]?.standard_set_version
  || !/^[a-f0-9]{16}$/.test(approval?.content_hash ?? "")
  || (approval?.pack_file_hash !== undefined && approval.pack_file_hash !== sha256(packBytes))
  || typeof approval?.approved_by !== "string" || !approval.approved_by.trim()
  || typeof approval?.approved_at !== "string" || !Number.isSafeInteger(approval?.task_count) || approval.task_count < 1) {
  throw new Error("trusted pack identity does not match the committed configuration");
}
if (vendor === "turso" && surface === "cli") {
  const turso = runtime.lock.turso_cli;
  if (configuration.turso_cli?.install_root !== resolve(turso.executable_path, "..", "..")
    || configuration.turso_cli?.version !== turso.version_output
    || configuration.turso_cli?.sha256 !== turso.executable_sha256
    || configuration.turso_cli?.provisioner?.id !== "ax-arena-turso-cli"
    || configuration.turso_cli?.provisioner?.version !== "1.0.0") {
    throw new Error("trusted Turso CLI pin does not match the reviewed runtime lock");
  }
} else if (configuration.turso_cli !== undefined) {
  throw new Error("trusted non-Turso-CLI cohort cannot configure a Turso binary");
}

process.stdout.write(`${JSON.stringify({
  source_sha: sourceSha,
  protected_default_branch: defaultBranch,
  protected_default_sha: git(root, ["rev-parse", defaultRef]),
  runtime_lock_sha256: runtime.sha256,
  configuration_sha256: sha256(readFileSync(configurationPath)),
})}\n`);
