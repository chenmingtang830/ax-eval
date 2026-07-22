import { lstatSync, realpathSync } from "node:fs";
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
}

interface BinaryInspection extends ProvisioningInspection {
  readonly binaryPath?: string;
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
  searchPath: string,
): BinaryInspection {
  let artifactDir: string;
  let workspace: string;
  try {
    artifactDir = existingDirectory(context.artifactDir, "artifact directory");
    workspace = existingDirectory(context.cwd, "cell workspace");
  } catch {
    return { ready: false, detail: "cell workspace and artifact directory must already exist" };
  }

  for (const entry of searchPath.split(delimiter).filter(Boolean)) {
    const candidate = resolve(entry, "turso");
    try {
      const binaryPath = realpathSync(candidate);
      const stat = lstatSync(binaryPath);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
      if (isInside(artifactDir, binaryPath)) {
        return { ready: false, detail: "preinstalled turso binary must not resolve inside the writable artifact directory" };
      }
      if (isInside(workspace, binaryPath)) {
        return { ready: false, detail: "preinstalled turso binary must not resolve inside the writable cell workspace" };
      }
      return { ready: true, binaryPath };
    } catch {
      // Continue searching the controller-selected path.
    }
  }
  return { ready: false, detail: "install a pinned turso binary outside the writable cell workspace" };
}

/** Create a no-download Turso CLI provider from controller-selected ambient
 * state. The injected values are snapshotted when the runtime registry is made. */
export function createTursoCliProvisioningProvider(
  options: TursoCliProvisioningOptions,
): ProvisioningProvider {
  const searchPath = options.searchPath;
  const home = options.home;
  return {
    id: "ax-arena-turso-cli",
    version: "1.0.0",
    matches: ({ cell, pack }) => cell.surface === "cli" && pack.name === "turso",
    async inspect(context) {
      const { binaryPath: _binaryPath, ...inspection } = inspectBinary(context, searchPath);
      return inspection;
    },
    async provision(context) {
      const inspection = inspectBinary(context, searchPath);
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
          ...(home ? { cli_home: home } : {}),
          provisioning: "preinstalled-pinned-binary",
        },
      };
    },
  };
}
