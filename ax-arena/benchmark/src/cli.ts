#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AUTHORING_COMMANDS,
  authoringCommandUsage,
  isAuthoringCommand,
  runAuthoringCommand,
} from "./authoring/commands.js";
import {
  RUNTIME_COMMANDS,
  isRuntimeCommand,
  runRuntimeCommand,
  runtimeCommandUsage,
} from "./runtime/commands.js";

export const BENCHMARK_USAGE = [
  "usage: ax-arena benchmark <command> [options]",
  "",
  "Authoring commands:",
  ...AUTHORING_COMMANDS.map((command) => `  ${command}`),
  "",
  "Runtime commands:",
  ...RUNTIME_COMMANDS.map((command) => `  ${command}`),
].join("\n");

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

const PROCESS_IO: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

export async function runArenaCli(
  argv: readonly string[],
  io: CliIo = PROCESS_IO,
  runtimeCwd = process.cwd(),
): Promise<number> {
  const [group, command] = argv;
  if (!group || group === "--help" || group === "-h" || group === "help") {
    io.stdout(BENCHMARK_USAGE);
    return 0;
  }
  if (group !== "benchmark") {
    io.stderr(`unknown ax-arena command: ${group}\n${BENCHMARK_USAGE}`);
    return 1;
  }
  if (!command || command === "--help" || command === "-h" || command === "help") {
    io.stdout(BENCHMARK_USAGE);
    return 0;
  }
  if (!isAuthoringCommand(command) && !isRuntimeCommand(command)) {
    io.stderr(`unknown benchmark command: ${command}\n${BENCHMARK_USAGE}`);
    return 1;
  }
  if (argv.slice(2).some((value) => value === "--help" || value === "-h" || value === "help")) {
    io.stdout(isAuthoringCommand(command) ? authoringCommandUsage(command) : runtimeCommandUsage(command));
    return 0;
  }
  try {
    return isAuthoringCommand(command)
      ? await runAuthoringCommand(command, argv.slice(2))
      : await runRuntimeCommand(command, argv.slice(2), io, runtimeCwd);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await runArenaCli(process.argv.slice(2));
}
