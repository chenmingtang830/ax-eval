import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { dirname, resolve } from "node:path";

export interface ArenaLaunch {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface ResolveArenaLaunchOptions {
  sourceCli: string;
  sourceLoader?: string;
  sourceTsconfig?: string;
  installedPackageJson?: string;
  env?: NodeJS.ProcessEnv;
}

export function arenaChildExitCode(status: number | null, signal: NodeJS.Signals | null): number {
  if (signal) return 128 + (osConstants.signals[signal] ?? 0);
  return status ?? 1;
}

/** Execute an already-resolved compatibility launch without a shell. */
export function executeArenaLaunch(launch: ArenaLaunch): number {
  const child = spawnSync(launch.executable, launch.args, {
    cwd: process.cwd(),
    env: launch.env,
    shell: false,
    stdio: "inherit",
  });
  if (child.error) throw new Error(`could not launch ax-arena: ${child.error.message}`);
  if (child.signal) console.error(`ax-arena terminated by signal ${child.signal}`);
  return arenaChildExitCode(child.status, child.signal);
}
/** Build a shell-free launch plan for one allowlisted compatibility command. */
export function resolveArenaLaunch(
  command: string,
  argv: readonly string[],
  options: ResolveArenaLaunchOptions,
): ArenaLaunch {
  const forwarded = ["benchmark", command, ...argv];
  const env = options.env ?? process.env;
  if (existsSync(options.sourceCli) && options.sourceLoader) {
    return {
      executable: process.execPath,
      args: ["--import", options.sourceLoader, options.sourceCli, ...forwarded],
      env: options.sourceTsconfig ? { ...env, TSX_TSCONFIG_PATH: options.sourceTsconfig } : env,
    };
  }
  if (options.installedPackageJson) {
    return {
      executable: process.execPath,
      args: [resolve(dirname(options.installedPackageJson), "dist", "cli.js"), ...forwarded],
      env,
    };
  }
  throw new Error("could not locate the installed @ax-arena/benchmark package");
}
