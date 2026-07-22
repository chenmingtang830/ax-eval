import type { BearerClientOptions } from "../http/client.js";
import type { TargetPack } from "../schemas.js";
import {
  authHeader,
  resolveEnvTemplate,
  resolveToken,
  type EnvSource,
} from "../target/config.js";
import type { ExecutorResults } from "./verify.js";

function convexVerificationBaseUrl(
  pack: TargetPack,
  executor: ExecutorResults,
  env: EnvSource,
): string {
  const discovered = executor.discovery?.base_url_found?.trim();
  if (discovered && /^https:\/\/[a-z0-9-]+\.convex\.cloud\/?$/i.test(discovered)) {
    return discovered.replace(/\/+$/, "");
  }
  return resolveEnvTemplate(pack.base_url, env);
}

export function buildVerificationClientOptions(
  pack: TargetPack,
  executor: ExecutorResults,
  env: EnvSource = process.env,
): BearerClientOptions {
  if (pack.name === "convex") {
    return {
      baseUrl: convexVerificationBaseUrl(pack, executor, env),
      token: "",
      responseEnvelope: pack.response_envelope,
      authScheme: "none",
      extraHeaders: pack.headers,
      apiStyle: pack.api_style,
    };
  }

  return {
    baseUrl: resolveEnvTemplate(pack.base_url, env),
    token: resolveToken(pack, env),
    responseEnvelope: pack.response_envelope,
    authScheme: pack.auth?.type ?? "bearer",
    authHeader: authHeader(pack),
    extraAuthHeader: pack.auth?.extra_header,
    extraHeaders: pack.headers,
    apiStyle: pack.api_style,
  };
}
