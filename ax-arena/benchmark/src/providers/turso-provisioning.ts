import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ProvisioningContext,
  ProvisioningInspection,
  ProvisioningProvider,
} from "ax-eval";

export interface TursoCliProvisioningOptions {
  /** Explicit controller-selected PATH. Provider methods never read ambient env. */
  readonly searchPath: string;
  readonly home?: string;
  readonly trustedInstallRoot?: string;
  readonly expectedVersion?: string;
  readonly expectedSha256?: string;
  /** Test/attestation hook; production leaves this as `turso`. */
  readonly executableName?: string;
}

interface BinaryInspection extends ProvisioningInspection {
  readonly binaryPath?: string;
  readonly cliVersion?: string;
  readonly cliSha256?: string;
}

function writableByCurrentProcess(stat: Stats): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const groups = typeof process.getgroups === "function" ? new Set(process.getgroups()) : new Set<number>();
  return Boolean((stat.mode & 0o002)
    // A same-UID owner can chmod a nominally read-only path and replace it.
    || (uid !== undefined && stat.uid === uid)
    || (groups.has(stat.gid) && (stat.mode & 0o020)));
}

function assertImmutablePath(binaryPath: string): void {
  let current = binaryPath;
  for (;;) {
    if (writableByCurrentProcess(lstatSync(current))) {
      throw new Error(`pinned turso path is writable by the controller user: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function existingDirectory(path: string, label: string): string {
  const canonical = realpathSync(resolve(path));
  const stat = lstatSync(canonical);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}

function inspectBinary(
  context: Omit<ProvisioningContext, "credentials">,
  options: TursoCliProvisioningOptions,
): BinaryInspection {
  let artifactDir: string;
  let workspace: string;
  try {
    artifactDir = existingDirectory(context.artifactDir, "artifact directory");
    workspace = existingDirectory(context.cwd, "cell workspace");
  } catch {
    return { ready: false, detail: "cell workspace and artifact directory must already exist" };
  }
  const expectedVersion = options.expectedVersion?.trim();
  const expectedSha256 = options.expectedSha256?.trim().toLowerCase();
  if (!expectedVersion || !expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)
    || !options.trustedInstallRoot) {
    return { ready: false, detail: "turso provisioning requires a trusted install root, exact version, and SHA-256 pin" };
  }
  let trustedRoot: string;
  try {
    trustedRoot = existingDirectory(options.trustedInstallRoot, "trusted turso install root");
  } catch (error) {
    return { ready: false, detail: error instanceof Error ? error.message : String(error) };
  }
  let lastDetail = "install the pinned turso binary under the trusted install root";

  for (const entry of options.searchPath.split(delimiter).filter(Boolean)) {
    const candidate = resolve(entry, options.executableName ?? "turso");
    try {
      if (lstatSync(candidate).isSymbolicLink()) throw new Error("pinned turso executable must not be a symlink");
      const binaryPath = realpathSync(candidate);
      const stat = lstatSync(binaryPath);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
      if (isInside(artifactDir, binaryPath)) {
        return { ready: false, detail: "preinstalled turso binary must not resolve inside the writable artifact directory" };
      }
      if (isInside(workspace, binaryPath)) {
        return { ready: false, detail: "preinstalled turso binary must not resolve inside the writable cell workspace" };
      }
      if (!isInside(trustedRoot, binaryPath)) throw new Error("pinned turso binary is outside the trusted install root");
      assertImmutablePath(binaryPath);
      const cliSha256 = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
      if (cliSha256 !== expectedSha256) throw new Error("pinned turso binary SHA-256 does not match controller policy");
      const cliVersion = execFileSync(binaryPath, ["--version"], {
        encoding: "utf8",
        env: {},
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim();
      if (cliVersion !== expectedVersion) throw new Error("pinned turso binary version does not match controller policy");
      return { ready: true, binaryPath, cliVersion, cliSha256 };
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
  }
  return { ready: false, detail: lastDetail };
}

/** Create a no-download Turso CLI provider from controller-selected ambient
 * state. The injected values are snapshotted when the runtime registry is made. */
export function createTursoCliProvisioningProvider(
  options: TursoCliProvisioningOptions,
): ProvisioningProvider {
  const snapshot = Object.freeze({ ...options });
  const home = snapshot.home;
  return {
    id: "ax-arena-turso-cli",
    version: "1.0.0",
    matches: ({ cell, pack }) => cell.surface === "cli" && pack.name === "turso",
    async inspect(context) {
      const {
        binaryPath: _binaryPath,
        cliVersion: _cliVersion,
        cliSha256: _cliSha256,
        ...inspection
      } = inspectBinary(context, snapshot);
      return inspection;
    },
    async provision(context) {
      const inspection = inspectBinary(context, snapshot);
      if (!inspection.ready || !inspection.binaryPath) {
        throw new Error(inspection.detail ?? "pinned turso binary is unavailable");
      }
      const binDir = dirname(inspection.binaryPath);
      return {
        // Core validates and prepends this external directory without allowing
        // arbitrary PATH replacement by the provider.
        env: { AX_ARENA_TURSO_BIN: inspection.binaryPath },
        pathEntries: [binDir],
        metadata: {
          cli_binary: inspection.binaryPath,
          cli_bin_dir: binDir,
          cli_version: inspection.cliVersion,
          cli_sha256: inspection.cliSha256,
          ...(home ? { cli_home: home } : {}),
          provisioning: "preinstalled-pinned-binary",
        },
      };
    },
  };
}
