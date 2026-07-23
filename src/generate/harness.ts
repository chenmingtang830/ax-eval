/**
 * Generic harness invocation: a small wrapper around claude-code / codex
 * subprocess calls, plus helpers for parsing their replies.
 *
 * Factored out of cli.ts so non-CLI callers (vendor-resolve and arena oracle extraction,
 * future composers) can invoke an LLM harness with their own prompts without
 * pulling in the entire CLI surface.
 *
 * Bin escape hatches: AX_EVAL_CLAUDE_BIN / AX_EVAL_CODEX_BIN let callers
 * bypass a PATH-shadowing wrapper (corp shims that inject PYTHONPATH and
 * break inside isolated processes). Defaults preserve "first match on PATH".
 *
 * invokeHarness is ASYNC — uses execFile so multiple calls via Promise.all
 * run concurrently (unlike spawnSync which blocks the event loop serially).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse as yamlParse } from "yaml";

interface RunResult {
  stdout: string;
  stderr: string;
}

class ProcessTimeoutError extends Error {
  killed = true;
}

/** Like execFile, but spawns detached (POSIX: child becomes its own process
 *  group leader) and kills the WHOLE group on timeout, not just the direct
 *  child. This matters because AX_EVAL_CLAUDE_BIN often points at a pnpm
 *  dlx shim that FORKS the real claude.exe as a child rather than exec-ing
 *  into it — plain execFile's `timeout` only signals the immediate child,
 *  leaving the real work orphaned and still running (and still consuming
 *  API concurrency / rate-limit slots) after we've already reported the
 *  call as failed. Confirmed by hand: a killed shim left `claude.exe`
 *  alive and burning CPU minutes after our process "gave up". */
type LooseExecFile = (
  bin: string,
  args: string[],
  options: {
    cwd: string;
    maxBuffer: number;
    encoding: string;
    detached: boolean;
    /** Close stdin so CLIs that optionally append piped stdin (notably
     *  `codex exec <PROMPT>`) do not hang forever on "Reading additional
     *  input from stdin..." when the parent process still has an open fd. */
    stdio?: ["ignore" | "pipe", "pipe", "pipe"];
  },
  callback: (error: (Error & { stderr?: string; killed?: boolean }) | null, stdout: string, stderr: string) => void,
) => { pid?: number; kill: (signal: string) => void };

function runDetached(bin: string, args: string[], opts: { cwd: string; maxBuffer: number; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    // `detached` isn't in @types/node's ExecFileOptions but IS honored by
    // the underlying spawn() — it's what lets us kill the whole process
    // group (see runDetached's docstring) rather than just the direct child.
    // stdin is ignored: Codex treats an open inherited stdin as "more prompt
    // may arrive" and stalls after the argv prompt with
    // "Reading additional input from stdin...".
    const child = (execFile as unknown as LooseExecFile)(
      bin,
      args,
      {
        cwd: opts.cwd,
        maxBuffer: opts.maxBuffer,
        encoding: "utf8",
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        if (error) {
          if (timedOut) reject(Object.assign(new ProcessTimeoutError(error.message), { stderr }));
          else reject(Object.assign(error, { stderr }));
        } else {
          resolvePromise({ stdout, stderr });
        }
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, opts.timeoutMs);
  });
}

export type HarnessId = "claude-code" | "codex";
export type Effort = "low" | "medium" | "high";

export interface InvokeHarnessOptions {
  harness: HarnessId;
  model?: string;
  effort?: Effort;
  /** Throw unless the harness's reply shows at least one WebSearch/WebFetch
   *  tool call. An instruction to "use WebFetch" in the prompt does not
   *  force tool use — models may answer from training data even with the
   *  tool permission granted. Use this for any research prompt where an
   *  ungrounded (training-only) answer must not be silently accepted. */
  requireWebFetch?: boolean;
  /** Kill the subprocess if it hasn't replied within this many ms (default
   *  5 min). A hung call previously ran silently with no error and no
   *  progress signal until manually killed. */
  timeoutMs?: number;
  /** Log a "still running" line to stderr every N ms while waiting, tagged
   *  with `label` (e.g. the vendor name) so parallel calls are distinguishable. */
  heartbeat?: { everyMs: number; label: string };
}

function withGroundingRequirement(prompt: string, retry: boolean): string {
  return [
    "GROUNDING REQUIREMENT: You MUST call WebSearch or WebFetch before answering.",
    "Do not answer from memory or prior knowledge alone.",
    retry
      ? "Your previous attempt was rejected because it answered without any WebSearch/WebFetch call. Retry correctly now: search/fetch the docs first, then answer."
      : "Any answer with zero WebSearch/WebFetch calls will be rejected.",
    "",
    prompt,
  ].join("\n");
}

interface VerboseMessage {
  type: string;
  message?: { content?: Array<{ type: string; name?: string }> };
  result?: string;
}

/** Count real WebFetch/WebSearch tool calls out of claude-code's
 *  `--output-format json --verbose` reply (a JSON array of turn messages).
 *
 *  NOTE: `usage.server_tool_use.web_fetch_requests` (present even without
 *  --verbose) only counts Anthropic's server-hosted web tools. In this
 *  environment WebFetch/WebSearch are CLIENT-SIDE tools (loaded via
 *  ToolSearch), so that counter stays 0 even when the tool was genuinely
 *  called — the only reliable signal is the `tool_use` blocks in the
 *  verbose transcript. Returns null if `raw` isn't the verbose array shape
 *  (fixtures, codex, non-verbose calls). */
export function countWebToolUse(raw: string): { webSearch: number; webFetch: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  let webSearch = 0;
  let webFetch = 0;
  for (const msg of parsed as VerboseMessage[]) {
    if (msg.type !== "assistant") continue;
    for (const block of msg.message?.content ?? []) {
      if (block.type !== "tool_use") continue;
      if (block.name === "WebSearch") webSearch++;
      if (block.name === "WebFetch") webFetch++;
    }
  }
  return { webSearch, webFetch };
}

export function countCodexWebToolUse(raw: string): { webSearch: number; webFetch: number } | null {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let sawEvent = false;
  let webSearch = 0;
  let webFetch = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { type?: string; item?: { type?: string } };
      if (parsed.type !== "item.completed") continue;
      sawEvent = true;
      if (parsed.item?.type === "web_search") webSearch++;
      if (parsed.item?.type === "web_fetch") webFetch++;
    } catch {
      continue;
    }
  }
  return sawEvent ? { webSearch, webFetch } : null;
}

/** Pull the final assistant text out of a `--verbose` reply (array of turn
 *  messages) — the last message with type "result". Returns null if `raw`
 *  isn't the verbose array shape. */
function extractVerboseResultText(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const resultMsg = [...(parsed as VerboseMessage[])].reverse().find((m) => m.type === "result");
  return typeof resultMsg?.result === "string" ? resultMsg.result : null;
}

/** Read a fixture file if AX_EVAL_GENERATOR_FIXTURE is set. Used by tests. */
export function readGeneratorFixture(): string | null {
  const fixture = process.env.AX_EVAL_GENERATOR_FIXTURE;
  return fixture ? readFileSync(fixture, "utf8") : null;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Invoke a harness with a prompt; returns its raw text output.
 *  Async so multiple concurrent calls via Promise.all run in parallel. */
export async function invokeHarness(prompt: string, opts: InvokeHarnessOptions): Promise<string> {
  const fixture = readGeneratorFixture();
  if (fixture) return fixture;

  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const heartbeatTimer = opts.heartbeat
    ? setInterval(() => {
        process.stderr.write(`  [${opts.heartbeat!.label}] still waiting on harness…\n`);
      }, opts.heartbeat.everyMs)
    : undefined;
  try {
    return await invokeHarnessInner(prompt, opts, timeout);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

async function invokeHarnessInner(prompt: string, opts: InvokeHarnessOptions, timeout: number): Promise<string> {
  if (opts.harness === "codex") {
    const codexBin = process.env.AX_EVAL_CODEX_BIN || "codex";
    const dir = mkdtempSync(resolve(tmpdir(), "ax-harness-"));
    const outPath = resolve(dir, "out.json");
    const modelArgs = opts.model ? ["-m", opts.model] : [];
    const effortArgs = opts.effort ? ["-c", `model_reasoning_effort=${opts.effort}`] : [];
    const { stdout, stderr } = await runDetached(codexBin, [
      "exec",
      "--sandbox", "workspace-write",
      "-c", "sandbox_workspace_write.network_access=true",
      "--json",
      ...modelArgs,
      ...effortArgs,
      "--output-last-message", outPath,
      prompt,
    ], { cwd: process.cwd(), maxBuffer: 50 * 1024 * 1024, timeoutMs: timeout }).catch((e) => {
      const label = opts.heartbeat?.label ? ` [${opts.heartbeat.label}]` : "";
      throw new Error(`harness codex${label} (${codexBin}) failed${e.killed ? ` (killed after ${timeout}ms timeout)` : ""}: ${e.message || stderr}`);
    });
    if (opts.requireWebFetch) {
      const label = opts.heartbeat?.label ? ` [${opts.heartbeat.label}]` : "";
      const counts = countCodexWebToolUse(stdout);
      if (!counts || (counts.webSearch === 0 && counts.webFetch === 0)) {
        throw new Error(`harness codex${label} answered without calling web_search — refusing an ungrounded reply`);
      }
    }
    return existsSync(outPath) ? readFileSync(outPath, "utf8") : stdout;
  }

  if (opts.harness === "claude-code") {
    const claudeBin = process.env.AX_EVAL_CLAUDE_BIN || "claude";
    const modelArgs = opts.model ? ["--model", opts.model] : [];
    // --verbose switches --output-format json from a single result object to
    // an array of turn messages, which is the only way to see real tool_use
    // blocks (see countWebToolUse). Only requested when grounding is being
    // enforced, to leave the existing non-DAEB generate path unchanged.
    const verboseArgs = opts.requireWebFetch ? ["--verbose"] : [];
    const runClaude = async (groundedPrompt: string): Promise<string> => {
      const { stdout } = await runDetached(
        claudeBin,
        ["-p", groundedPrompt, "--output-format", "json", "--allowedTools", "WebSearch,WebFetch", ...verboseArgs, ...modelArgs],
        { cwd: process.cwd(), maxBuffer: 50 * 1024 * 1024, timeoutMs: timeout },
      ).catch((e) => {
        const label = opts.heartbeat?.label ? ` [${opts.heartbeat.label}]` : "";
        throw new Error(`harness claude-code${label} (${claudeBin}) failed${e.killed ? ` (killed after ${timeout}ms timeout)` : ""}: ${e.message || e.stderr}`);
      });
      return stdout;
    };
    let stdout = await runClaude(opts.requireWebFetch ? withGroundingRequirement(prompt, false) : prompt);
    if (opts.requireWebFetch) {
      const label = opts.heartbeat?.label ? ` [${opts.heartbeat.label}]` : "";
      let counts = countWebToolUse(stdout);
      if (!counts || (counts.webSearch === 0 && counts.webFetch === 0)) {
        stdout = await runClaude(withGroundingRequirement(prompt, true));
        counts = countWebToolUse(stdout);
      }
      if (!counts || (counts.webSearch === 0 && counts.webFetch === 0)) {
        throw new Error(
          `harness claude-code${label} answered without calling WebSearch or WebFetch — refusing an ungrounded (training-data-only) answer for a grounded-research prompt`,
        );
      }
      const text = extractVerboseResultText(stdout);
      if (text === null) throw new Error(`harness claude-code${label} --verbose reply had no final result message`);
      return text;
    }
    return normalizeHarnessText(stdout);
  }

  throw new Error(`harness ${opts.harness} cannot be invoked headlessly`);
}

export interface InvokeGeneratorOptions {
  /** Require the reply to show at least one server-side web search/fetch call. */
  requireWebFetch?: boolean;
  /** Fallback local harness to use when no direct API key is configured. */
  fallbackHarness?: HarnessId;
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
  heartbeat?: { everyMs: number; label: string };
}

export interface RepairJsonOptions {
  fallbackHarness?: HarnessId;
  model?: string;
  effort?: Effort;
  label?: string;
}

const GENERATOR_TIMEOUT_MS = 5 * 60 * 1000;

/** Invoke an LLM for ax-eval's OWN generation tooling (vendor-resolve,
 *  capability-extract plus arena synthesize-suite/oracle-extract/compose-pack) — this
 *  is NOT the benchmarked harness call (that stays in invokeHarness/exec-plan,
 *  since claude-code/codex's real CLI behavior is literally the thing under
 *  test). Generation tooling has no reason to shell out to a CLI binary at
 *  all: it just needs an LLM with a web-search tool, so this calls whichever
 *  provider's API key the user has configured directly, using that
 *  provider's hosted (server-side) web search tool — no subprocess, no
 *  binary-path resolution, no process-group/timeout footguns. Falls back to
 *  invokeHarness's subprocess path (existing claude-code/codex CLI login)
 *  only if neither API key is set, for users without a direct API key. */
export async function invokeGenerator(prompt: string, opts: InvokeGeneratorOptions = {}): Promise<string> {
  const fixture = readGeneratorFixture();
  if (fixture) return fixture;

  const timeout = opts.timeoutMs ?? GENERATOR_TIMEOUT_MS;
  const preferredHarness = opts.fallbackHarness;
  const heartbeatTimer = opts.heartbeat
    ? setInterval(() => process.stderr.write(`  [${opts.heartbeat!.label}] still waiting on generator…\n`), opts.heartbeat.everyMs)
    : undefined;
  try {
    if (preferredHarness === "codex" && process.env.OPENAI_API_KEY) return await invokeOpenAiApi(prompt, opts, timeout);
    if (preferredHarness === "claude-code" && process.env.ANTHROPIC_API_KEY) return await invokeAnthropicApi(prompt, opts, timeout);
    if (process.env.ANTHROPIC_API_KEY) return await invokeAnthropicApi(prompt, opts, timeout);
    if (process.env.OPENAI_API_KEY) return await invokeOpenAiApi(prompt, opts, timeout);
    // Fallback: no direct API key configured, use whichever local harness CLI is logged in.
    const fallbackHarness = opts.fallbackHarness ?? "claude-code";
    return await invokeHarness(prompt, {
      harness: fallbackHarness,
      model: opts.model,
      effort: opts.effort,
      requireWebFetch: opts.requireWebFetch,
      timeoutMs: timeout,
    });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

async function invokeAnthropicApi(prompt: string, opts: InvokeGeneratorOptions, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const blocks = data.content ?? [];
    if (opts.requireWebFetch && !blocks.some((b) => b.type === "server_tool_use")) {
      throw new Error("generator answered without calling web_search — refusing an ungrounded reply");
    }
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    if (!text) throw new Error("Anthropic API reply had no text content");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function invokeOpenAiApi(prompt: string, opts: InvokeGeneratorOptions, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        tools: [{ type: "web_search_preview" }],
        input: prompt,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> };
    const output = data.output ?? [];
    if (opts.requireWebFetch && !output.some((o) => o.type === "web_search_call")) {
      throw new Error("generator answered without calling web_search — refusing an ungrounded reply");
    }
    const text = output
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join("\n");
    if (!text) throw new Error("OpenAI API reply had no text content");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** claude-code's --output-format json wraps the assistant text in a JSON
 *  envelope with a `result` (or `message` / `output`) string. Normalize to
 *  the inner text. */
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

/** Extract a JSON object or array substring from the harness's reply.
 *  Handles fenced code blocks and stray prose around the JSON. */
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return extractJsonObject(fenced[1]);
  const firstArr = trimmed.indexOf("[");
  const lastArr = trimmed.lastIndexOf("]");
  if (firstArr >= 0 && lastArr > firstArr) return trimmed.slice(firstArr, lastArr + 1);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  try {
    const parsed = yamlParse(trimmed);
    if (parsed && typeof parsed === "object") return JSON.stringify(parsed);
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error("harness did not return a JSON object or array");
}

export async function extractJsonObjectWithRepair(raw: string, opts: RepairJsonOptions = {}): Promise<string> {
  try {
    return extractJsonObject(raw);
  } catch (error) {
    const repaired = await invokeGenerator(
      [
        "Reformat the following content into a valid JSON object or JSON array only.",
        "Preserve the original fields and values as faithfully as possible.",
        "Do not add commentary, markdown fences, or explanatory text.",
        "",
        "CONTENT:",
        raw,
      ].join("\n"),
      {
        fallbackHarness: opts.fallbackHarness,
        model: opts.model,
        effort: opts.effort,
        timeoutMs: 2 * 60 * 1000,
        heartbeat: opts.label ? { everyMs: 30_000, label: `${opts.label}/json-repair` } : undefined,
      },
    );
    try {
      return extractJsonObject(repaired);
    } catch {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} (repair pass also failed)`);
    }
  }
}
