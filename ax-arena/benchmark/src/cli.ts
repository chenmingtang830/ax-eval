#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BENCHMARK_USAGE = [
  "usage: ax-arena benchmark <command> [options]",
  "",
  "The benchmark workspace is established, but commands move in later migration slices.",
].join("\n");

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

const PROCESS_IO: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

export function runArenaCli(argv: readonly string[], io: CliIo = PROCESS_IO): number {
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
  io.stderr(`benchmark command is not implemented in the workspace scaffold: ${command}`);
  return 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = runArenaCli(process.argv.slice(2));
}
