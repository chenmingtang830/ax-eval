import { describe, expect, it } from "vitest";
import { probeHarness } from "../src/harness/probe.js";
import { HOST_MODEL } from "../src/harness/profile.js";

describe("probeHarness", () => {
  it("detects Cursor and suggests the standard medium effort", () => {
    const p = probeHarness({ CURSOR_AGENT: "1", CURSOR_TRACE_ID: "abc", PATH: "/usr/bin" });
    expect(p.host).toBe("cursor");
    expect(p.confidence).toBe("high");
    expect(p.model).toBe(HOST_MODEL);
    expect(p.suggestion.profiles).toEqual(["medium"]);
    expect(p.suggestion.matrix).toBe(false);
    // Key names only — never values.
    expect(p.signals).toContain("CURSOR_AGENT");
    expect(JSON.stringify(p)).not.toContain("abc");
  });

  it("detects Claude Code and suggests the sonnet profile", () => {
    const p = probeHarness({ CLAUDECODE: "1", ANTHROPIC_MODEL: "claude-4.6-sonnet" });
    expect(p.host).toBe("claude-code");
    expect(p.confidence).toBe("high");
    expect(p.model).toBe("claude-4.6-sonnet");
    expect(p.suggestion.profiles).toEqual(["sonnet"]);
  });

  it("falls back to the default model when Claude Code declares no model env", () => {
    const p = probeHarness({ CLAUDE_CODE_ENTRYPOINT: "cli" });
    expect(p.host).toBe("claude-code");
    expect(p.model).toBe("sonnet");
  });

  it("detects OpenAI Codex and suggests the gpt5 profile", () => {
    const p = probeHarness({ CODEX_SANDBOX: "seatbelt", OPENAI_MODEL: "gpt-5.5" });
    expect(p.host).toBe("codex");
    expect(p.confidence).toBe("high");
    expect(p.model).toBe("gpt-5.5");
    expect(p.suggestion.profiles).toEqual(["gpt5"]);
  });

  it("a bare API key is a weak (low-confidence) signal", () => {
    const p = probeHarness({ OPENAI_API_KEY: "sk-xxx" });
    expect(p.host).toBe("codex");
    expect(p.confidence).toBe("low");
    expect(p.signals).toContain("OPENAI_API_KEY");
  });

  it("an agent host wins over a generic CI signal", () => {
    const p = probeHarness({ CI: "true", GITHUB_ACTIONS: "true", CURSOR_AGENT: "1" });
    expect(p.host).toBe("cursor");
  });

  it("detects a generic CI runner with no agent markers", () => {
    const p = probeHarness({ CI: "true", GITHUB_ACTIONS: "true" });
    expect(p.host).toBe("ci");
    expect(p.confidence).toBe("high");
    expect(p.model).toBeNull();
    expect(p.suggestion.profiles).toEqual(["medium"]);
  });

  it("falls back to unknown/host-default when nothing matches", () => {
    const p = probeHarness({ PATH: "/usr/bin", HOME: "/root" });
    expect(p.host).toBe("unknown");
    expect(p.confidence).toBe("none");
    expect(p.model).toBeNull();
    expect(p.signals).toEqual([]);
    expect(p.suggestion.profiles).toEqual(["medium"]);
    expect(p.suggestion.matrix).toBe(false);
  });

  it("records reproducibility provenance and never throws", () => {
    const p = probeHarness({});
    expect(typeof p.node).toBe("string");
    expect(typeof p.platform).toBe("string");
    expect(typeof p.arch).toBe("string");
    expect(p.detectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});
