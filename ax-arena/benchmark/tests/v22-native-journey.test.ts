import { describe, expect, it } from "vitest";
import {
  analyzeV22Transcript,
  buildV22NativeJourneyPrompt,
  scoreV22Stages,
  type V22Vendor,
} from "../src/runtime/v22-native-journey.js";

const vendor: V22Vendor = {
  display_name: "ExampleDB",
  base_pack: "pack.yaml",
  credential_envs: ["EXAMPLE_TOKEN", "EXAMPLE_DATABASE_URL"],
  scope_envs: ["EXAMPLE_PROJECT_ID"],
  data_connection_env: "EXAMPLE_DATABASE_URL",
  native_markers: ["examplectl"],
  official_domains: ["example.com"],
};

describe("V2.2 native journey", () => {
  it("does not leak a binary, command, endpoint, docs URL, or hidden oracle contract", () => {
    const prompt = buildV22NativeJourneyPrompt({
      vendor,
      vendorSlug: "example",
      namespace: "v22_example_1",
      resultsPath: "/tmp/results.json",
      tracePath: "/tmp/trace.json",
    });
    expect(prompt).not.toContain("examplectl");
    expect(prompt).not.toContain("example.com");
    expect(prompt).not.toContain("SELECT COUNT");
    expect(prompt).toContain("EXAMPLE_TOKEN");
    expect(prompt).toContain("id INTEGER PRIMARY KEY, marker TEXT UNIQUE NOT NULL");
    expect(prompt).toContain("strictly increasing positive step number");
  });

  it("separates assisted discovery and recovery from final world state", () => {
    const transcript = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "examplectl --help" } }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "examplectl show \"$DAEB_NATIVE_STALE_TARGET\"" } }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "psql \"$EXAMPLE_DATABASE_URL\" -c 'create table x(id int)'" } }),
    ].join("\n");
    const evidence = analyzeV22Transcript({ transcript, vendor, staleTarget: "missing", outcomePassed: true });
    expect(evidence.discovery_mode).toBe("assisted-discovery");
    expect(evidence.native_entrypoint_observed).toBe(true);
    expect(evidence.stale_target_attempted).toBe(true);
    expect(scoreV22Stages(evidence, {
      connection_ok: true,
      total_rows: 3,
      active_rows: 2,
      alpha_rows: 1,
      recovered_rows: 1,
      primary_constraints: 1,
      unique_constraints: 1,
    })).toEqual({ discovery: true, connect: true, operate: true, recovery: true });
  });

  it("does not convert a usable outcome into discovery or recovery evidence", () => {
    const transcript = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "a",
      toolName: "bash",
      args: { command: "psql \"$EXAMPLE_DATABASE_URL\" -c 'select 1'" },
    });
    const evidence = analyzeV22Transcript({ transcript, vendor, staleTarget: "missing", outcomePassed: true });
    const score = scoreV22Stages(evidence, {
      connection_ok: true,
      total_rows: 3,
      active_rows: 2,
      alpha_rows: 1,
      recovered_rows: 1,
      primary_constraints: 1,
      unique_constraints: 1,
    });
    expect(score.operate).toBe(true);
    expect(score.discovery).toBe(false);
    expect(score.recovery).toBe(false);
  });

  it("does not count a credential env name or generic client help as a native entrypoint", () => {
    const transcript = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "psql --help" } }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "psql \"$EXAMPLE_DATABASE_URL\" -c 'select 1'" } }),
    ].join("\n");
    const evidence = analyzeV22Transcript({ transcript, vendor, staleTarget: "missing", outcomePassed: true });
    expect(evidence.help_inspected).toBe(false);
    expect(evidence.official_source_observed).toBe(false);
    expect(evidence.native_entrypoint_observed).toBe(false);
  });

  it("recovers stale-probe evidence from a Pi tool-call line even when redaction damaged other JSONL lines", () => {
    const transcript = [
      "{not-valid-json",
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "stale",
        toolName: "bash",
        args: { command: "examplectl show $DAEB_NATIVE_STALE_TARGET || true" },
      }),
    ].join("\n");
    const evidence = analyzeV22Transcript({ transcript, vendor, staleTarget: "missing", outcomePassed: true });
    expect(evidence.transcript_invalid_lines).toBe(1);
    expect(evidence.stale_target_attempted).toBe(true);
  });
});
