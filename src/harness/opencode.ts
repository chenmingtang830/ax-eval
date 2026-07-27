import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

/** OpenCode-specific routing and isolation policy shared by CLI and cell runs. */

export const OPENCODE_PROVIDER_ENV_BY_ID: Readonly<Record<string, readonly string[]>> = {
  openrouter: ["OPENROUTER_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
  xai: ["XAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  cohere: ["COHERE_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
};

const RESERVED_CHILD_ENV = new Set([
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
]);

export function isOpenCodeModelRoute(value: unknown): value is string {
  return typeof value === "string" && /^[^/\s]+\/[^\s]+$/.test(value);
}

export function openCodeProviderId(model: string): string {
  const slash = model.indexOf("/");
  return (slash >= 0 ? model.slice(0, slash) : model).toLowerCase();
}

export function openCodeProviderCredentialNames(model: string): readonly string[] {
  return OPENCODE_PROVIDER_ENV_BY_ID[openCodeProviderId(model)] ?? [];
}

export function isOpenCodeReservedChildEnv(name: string): boolean {
  const normalized = name.toUpperCase();
  return normalized.startsWith("OPENCODE_") || RESERVED_CHILD_ENV.has(normalized);
}

export interface OpenCodeManagedConfigContext {
  platform?: NodeJS.Platform;
  username?: string;
  programData?: string;
}

/** OpenCode 1.18.3 loads these controller-external sources after ordinary
 * config, so an evaluation cannot safely continue when any are present. */
export function openCodeManagedConfigCandidates(
  context: OpenCodeManagedConfigContext = {},
): string[] {
  const platform = context.platform ?? process.platform;
  const managedDir = platform === "darwin"
    ? "/Library/Application Support/opencode"
    : platform === "win32"
      ? join(context.programData || "C:\\ProgramData", "opencode")
      : "/etc/opencode";
  const candidates = [
    join(managedDir, "opencode.json"),
    join(managedDir, "opencode.jsonc"),
  ];
  if (platform !== "darwin") return candidates;
  let username = context.username;
  if (!username) {
    try {
      username = userInfo().username || "user";
    } catch {
      username = "user";
    }
  }
  return [
    ...candidates,
    join("/Library/Managed Preferences", username, "ai.opencode.managed.plist"),
    join("/Library/Managed Preferences", "ai.opencode.managed.plist"),
  ];
}

export function findOpenCodeManagedConfig(
  context: OpenCodeManagedConfigContext = {},
  pathExists: (path: string) => boolean = existsSync,
): string[] {
  return openCodeManagedConfigCandidates(context).filter(pathExists);
}
