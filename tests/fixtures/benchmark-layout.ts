import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { afterEach } from "vitest";
import { buildBenchmarkLayout, type BenchmarkLayout } from "../../src/generate/benchmark-paths.js";

export interface BenchmarkTestLayout {
  layout(): BenchmarkLayout;
  writeYaml(path: string, value: unknown): void;
}

export function useBenchmarkTestLayout(prefix: string): BenchmarkTestLayout {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  return {
    layout(): BenchmarkLayout {
      const root = mkdtempSync(join(tmpdir(), prefix));
      directories.push(root);
      return buildBenchmarkLayout(root, "database-eval", "v1");
    },
    writeYaml(path: string, value: unknown): void {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, yamlStringify(value));
    },
  };
}
