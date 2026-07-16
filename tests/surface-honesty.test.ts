import { describe, expect, it } from "vitest";
import { detectWireSignals, gradeSurfaceHonesty } from "../src/generate/surface-honesty.js";
import { parseTranscriptContent } from "../src/harness/transcript.js";
import type { TargetPack } from "../src/schemas.js";

const pack = {
  name: "neon",
  version: "1",
  base_url: "https://console.neon.tech/api/v2",
  auth: { type: "bearer", env: "NEON_API_KEY" },
  tasks: [],
} as unknown as TargetPack;

describe("surface honesty", () => {
  it("detects psql and pg client wire signals", () => {
    expect(detectWireSignals("psql \"$NEON_DATABASE_URL\" -c 'SELECT 1'")).toContain("psql");
    expect(detectWireSignals("node -e \"require('pg'); process.env.NEON_DATABASE_URL\"")).toEqual(
      expect.arrayContaining(["pg", "sql_env"]),
    );
  });

  it("fails api cells that only use SQL wire", () => {
    const text = [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "node -e \"const {Client}=require('pg'); new Client({connectionString:process.env.NEON_DATABASE_URL})\"",
        },
      }),
    ].join("\n");
    const run = parseTranscriptContent(text, { baseUrl: pack.base_url });
    const grade = gradeSurfaceHonesty(run, "api", pack);
    expect(grade.passed).toBe(false);
    expect(grade.wireSignals.length).toBeGreaterThan(0);
  });

  it("passes api cells that hit the pack HTTP host", () => {
    const text = [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "curl -s -X GET https://console.neon.tech/api/v2/projects -H 'authorization: Bearer $NEON_API_KEY'",
        },
      }),
    ].join("\n");
    const run = parseTranscriptContent(text, { baseUrl: pack.base_url });
    expect(gradeSurfaceHonesty(run, "api", pack).passed).toBe(true);
  });

  it("does not gate cli cells that use psql", () => {
    const text = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "psql \"$NEON_DATABASE_URL\" -c 'SELECT 1'" },
      }),
    ].join("\n");
    const run = parseTranscriptContent(text, { baseUrl: pack.base_url });
    expect(gradeSurfaceHonesty(run, "cli", pack).passed).toBe(true);
  });
});
