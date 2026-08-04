/** Pi-specific model routing and isolated-runtime policy. */

export const PI_PROVIDER_ENV_BY_ID: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
  xai: ["XAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  cohere: ["COHERE_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
};

export function isPiModelRoute(value: unknown): value is string {
  return typeof value === "string" && /^[^/\s]+\/[^\s]+$/.test(value);
}

export function piProviderId(model: string): string {
  return model.slice(0, model.indexOf("/")).toLowerCase();
}

export function piModelId(model: string): string {
  return model.slice(model.indexOf("/") + 1);
}

export function piProviderCredentialNames(model: string): readonly string[] {
  return PI_PROVIDER_ENV_BY_ID[piProviderId(model)] ?? [];
}

export function isPiReservedChildEnv(name: string): boolean {
  const normalized = name.toUpperCase();
  return normalized.startsWith("PI_") || normalized === "HOME";
}
