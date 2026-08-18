import { describe, expect, it } from "vitest";
import {
  analyzeV22Transcript,
  buildV22NativeJourneyPrompt,
  classifyV22CellStatus,
  scoreV22Stages,
  type V22Vendor,
} from "../src/runtime/v22-native-journey.js";
import { createMacOsWorkspaceWriteSandbox } from "../src/runtime/macos-workspace-sandbox.js";

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
    expect(prompt).toContain("Never expand a credential into source code");
    expect(prompt).toContain("Do not reverse-engineer an SDK");
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

  it("keeps a missing agent artifact after tool use as invalid evidence, not a product failure", () => {
    const evidence = analyzeV22Transcript({
      transcript: JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "a",
        toolName: "bash",
        args: { command: "examplectl --help" },
      }),
      vendor,
      staleTarget: "missing",
      outcomePassed: false,
    });
    expect(classifyV22CellStatus({
      routeMismatch: false,
      invocation: { ok: false, validity_status: "trace_invalid" },
      cleanupSuccess: true,
      evidence,
      stages: { discovery: false, connect: false, operate: false, recovery: false },
    })).toBe("invalid-evidence");
  });

  it("does not make a completed journey fail solely because a native marker was not observed", () => {
    expect(classifyV22CellStatus({
      routeMismatch: false,
      invocation: { ok: true, validity_status: "valid" },
      cleanupSuccess: true,
      evidence: analyzeV22Transcript({
        transcript: JSON.stringify({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "psql \"$EXAMPLE_DATABASE_URL\" -c 'select 1'" } }),
        vendor,
        staleTarget: "missing",
        outcomePassed: true,
      }),
      stages: { discovery: false, connect: true, operate: true, recovery: true },
    })).toBe("pass");
  });

  it("scores an agent-visible runtime timeout as a journey failure", () => {
    expect(classifyV22CellStatus({
      routeMismatch: false,
      invocation: { ok: false, validity_status: "runtime_timeout_partial", timed_out: true },
      cleanupSuccess: true,
      evidence: analyzeV22Transcript({
        transcript: JSON.stringify({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "examplectl list" } }),
        vendor,
        staleTarget: "missing",
        outcomePassed: false,
      }),
      stages: { discovery: false, connect: false, operate: false, recovery: false },
    })).toBe("fail");
  });

  it("keeps a pre-agent controller failure invalid infrastructure", () => {
    expect(classifyV22CellStatus({
      routeMismatch: false,
      invocation: { ok: false, validity_status: "trace_invalid" },
      cleanupSuccess: true,
      evidence: null,
      stages: { discovery: false, connect: false, operate: false, recovery: false },
    })).toBe("invalid-infra");
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

  it("wraps a local harness with a cell-only macOS write sandbox", () => {
    const sandbox = createMacOsWorkspaceWriteSandbox({
      writableRoot: process.cwd(),
      temporaryWritableRoot: process.cwd(),
      platform: "darwin",
      executable: "/bin/echo",
    });
    const wrapped = sandbox.wrap({ command: "pi", args: ["--print"], cwd: process.cwd() });
    expect(wrapped.command).toBe("/bin/echo");
    expect(wrapped.args.slice(0, 2)).toEqual(["-p", expect.stringContaining("(deny default)" )]);
    expect(wrapped.args[1]).toContain("(allow file-write*");
    expect(wrapped.args[1]!.match(/allow file-write\*/g)).toHaveLength(2);
    expect(wrapped.args).toEqual(expect.arrayContaining(["pi", "--print"]));
  });

  it("fails closed when macOS Seatbelt is unavailable", () => {
    expect(() => createMacOsWorkspaceWriteSandbox({
      writableRoot: process.cwd(),
      platform: "linux",
    })).toThrow("requires macOS Seatbelt");
  });
});
