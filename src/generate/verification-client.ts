import type { BearerClientOptions } from "../http/client.js";
import type { TargetPack } from "../schemas.js";
import { authHeader, resolveEnvTemplate, resolveToken } from "../target/config.js";

export function buildVerificationClientOptions(pack: TargetPack): BearerClientOptions {
  return {
    baseUrl: resolveEnvTemplate(pack.base_url),
    token: resolveToken(pack),
    responseEnvelope: pack.response_envelope,
    authScheme: pack.auth?.type ?? "bearer",
    authHeader: authHeader(pack),
    extraAuthHeader: pack.auth?.extra_header,
    extraHeaders: pack.headers,
    apiStyle: pack.api_style,
  };
}
