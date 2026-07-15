import { isIP } from "node:net";
import { z } from "zod";

export function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!(["http:", "https:"] as string[]).includes(url.protocol)) return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
    if (isIP(host) !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

export const PublicHttpUrlSchema = z.string().url().refine(
  isPublicHttpUrl,
  "must be a public http(s) URL without credentials",
);

export function urlUsesOfficialHost(value: string, officialRoots: readonly (string | null)[]): boolean {
  const host = new URL(value).hostname.toLowerCase();
  return officialRoots.some((root) => {
    if (!root) return false;
    const officialHost = new URL(root).hostname.toLowerCase();
    return host === officialHost || host.endsWith(`.${officialHost}`);
  });
}
