/**
 * Generic harness invocation: a small wrapper around claude-code / codex
 * subprocess calls, plus helpers for parsing their replies.
 *
 * Factored out of cli.ts so non-CLI callers (vendor-resolve, task-extract,
 * future composers) can invoke an LLM harness with their own prompts without
 * pulling in the entire CLI surface.
 *
 * Bin escape hatches: AX_EVAL_CLAUDE_BIN / AX_EVAL_CODEX_BIN let callers
 * bypass a PATH-shadowing wrapper (corp shims that inject PYTHONPATH and
 * break inside isolated processes). Defaults preserve "first match on PATH".
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

export type HarnessId = "claude-code" | "codex";
export type Effort = "low" | "medium" | "high";

export interface InvokeHarnessOptions {
  harness: HarnessId;
  model?: string;
  effort?: Effort;
}

/** Read a fixture file if AX_EVAL_GENERATOR_FIXTURE is set. Used by tests. */
export function readGeneratorFixture(): string | null {
  const fixture = process.env.AX_EVAL_GENERATOR_FIXTURE;
  return fixture ? readFileSync(fixture, "utf8") : null;
}

/** Invoke a harness with a prompt; return its raw text output. */
export function invokeHarness(prompt: string, opts: InvokeHarnessOptions): string {
  const fixture = readGeneratorFixture();
  if (fixture) return fixture;

  if (opts.harness === "codex") {
    const codexBin = process.env.AX_EVAL_CODEX_BIN || "codex";
    const dir = mkdtempSync(resolve(tmpdir(), "ax-harness-"));
    const outPath = resolve(dir, "out.json");
    const modelArgs = opts.model ? ["-m", opts.model] : [];
    const effortArgs = opts.effort ? ["-c", `model_reasoning_effort=${opts.effort}`] : [];
    const res = spawnSync(codexBin, [
      "exec",
      "--sandbox", "workspace-write",
      "-c", "sandbox_workspace_write.network_access=true",
      "--json",
      ...modelArgs,
      ...effortArgs,
      "--output-last-message", outPath,
      prompt,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    if (res.error || (res.status ?? 1) !== 0) {
      throw new Error(`harness codex (${codexBin}) failed: ${res.error?.message || res.stderr || `exit ${res.status}`}`);
    }
    return existsSync(outPath) ? readFileSync(outPath, "utf8") : res.stdout;
  }

  if (opts.harness === "claude-code") {
    const claudeBin = process.env.AX_EVAL_CLAUDE_BIN || "claude";
    const modelArgs = opts.model ? ["--model", opts.model] : [];
    const res = spawnSync(claudeBin, ["-p", prompt, "--output-format", "json", ...modelArgs], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    if (res.error || (res.status ?? 1) !== 0) {
      throw new Error(`harness claude-code (${claudeBin}) failed: ${res.error?.message || res.stderr || `exit ${res.status}`}`);
    }
    return normalizeHarnessText(res.stdout);
  }

  throw new Error(`harness ${opts.harness} cannot be invoked headlessly`);
}

/** claude-code's --output-format json wraps the assistant text in a JSON
 *  envelope with a `result` (or `message` / `output`) string. Codex's
 *  --output-last-message writes the raw assistant text. Normalize both
 *  shapes to the inner text. */
export function normalizeHarnessText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.result === "string") return parsed.result;
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.output === "string") return parsed.output;
  } catch {
    // Plain JSON object or plain text; extractJsonObject handles both.
  }
  return trimmed;
}

/** Extract a JSON object substring from the harness's reply. Handles
 *  fenced code blocks and stray prose around the object. */
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return extractJsonObject(fenced[1]);
  // Try array first, then object.
  const firstArr = trimmed.indexOf("[");
  const lastArr = trimmed.lastIndexOf("]");
  if (firstArr >= 0 && lastArr > firstArr) return trimmed.slice(firstArr, lastArr + 1);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  throw new Error("harness did not return a JSON object or array");
}
