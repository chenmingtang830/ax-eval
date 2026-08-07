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

  it("fails api cells that invoke a vendor CLI even when API calls also succeed", () => {
    const insforge = {
      ...pack,
      name: "insforge",
      base_url: "https://sandbox.insforge.app",
    } as TargetPack;
    const text = JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: [
          "npx @insforge/cli projects restore",
          "curl -s -X POST https://sandbox.insforge.app/api/database/tables",
        ].join(" && "),
      },
    });
    const run = parseTranscriptContent(text, {
      baseUrl: insforge.base_url,
      cliBins: ["insforge", "@insforge/cli"],
    });
    const grade = gradeSurfaceHonesty(run, "api", insforge);
    expect(run.cliCommands).toEqual(["@insforge/cli projects restore"]);
    expect(run.apiCalls).toHaveLength(1);
    expect(grade.passed).toBe(false);
    expect(grade.detail).toContain("cross-surface");
  });

  it("does not mistake a pack name inside a quoted URL pattern for its CLI", () => {
    const exa = { ...pack, name: "exa", base_url: "https://api.exa.ai" } as TargetPack;
    const text = JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "curl -s https://docs.exa.ai/reference/search | grep -oE '(api.exa.ai|exa.ai/api)'",
      },
    });
    const run = parseTranscriptContent(text, { baseUrl: exa.base_url, cliBins: ["exa", "@exa/cli"] });
    expect(run.cliCommands).toEqual([]);
    expect(gradeSurfaceHonesty(run, "api", exa).passed).toBe(true);
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
