import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
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

export interface ExecuteArenaLaunchOptions {
  cwd?: string;
  /** Test seam; production re-raises the child's terminal signal. */
  reraiseSignal?(signal: NodeJS.Signals): void;
}

const FORWARDED_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

/** Execute an already-resolved compatibility launch without a shell. Parent
 * cancellation is forwarded and child signal termination is re-raised so the
 * launcher has the same terminal semantics as invoking ax-arena directly. */
export function executeArenaLaunch(
  launch: ArenaLaunch,
  options: ExecuteArenaLaunchOptions = {},
): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const child = spawn(launch.executable, launch.args, {
      cwd: options.cwd ?? process.cwd(),
      env: launch.env,
      shell: false,
      stdio: "inherit",
    });
    let settled = false;
    const handlers = new Map<NodeJS.Signals, () => void>();
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();
    };
    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`could not launch ax-arena: ${error.message}`));
    });
    child.once("exit", (status, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal) {
        console.error(`ax-arena terminated by signal ${signal}`);
        const reraise = options.reraiseSignal ?? ((terminalSignal: NodeJS.Signals) => {
          process.kill(process.pid, terminalSignal);
        });
        try {
          reraise(signal);
        } catch (error) {
          console.error(`could not re-raise ${signal}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      resolveStatus(arenaChildExitCode(status, signal));
    });
  });
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
