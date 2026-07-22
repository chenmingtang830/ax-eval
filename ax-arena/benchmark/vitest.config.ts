import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "ax-eval": fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Controller lifecycle tests create real local git repositories so source
    // SHA and committed-byte checks exercise the production boundary. Those
    // subprocess-heavy fixtures can exceed Vitest's 5s default on macOS.
    testTimeout: 30_000,
  },
});
