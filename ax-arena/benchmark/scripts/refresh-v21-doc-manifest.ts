#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify } from "yaml";

const urls: Record<string, string[]> = {
  cockroachdb: [
    "https://www.cockroachlabs.com/docs/stable/cockroach-sql-binary",
    "https://www.cockroachlabs.com/docs/stable/security-reference/authorization",
    "https://www.cockroachlabs.com/docs/stable/sql-statements",
    "https://www.cockroachlabs.com/docs/stable/vector",
    "https://www.cockroachlabs.com/docs/v26.2/full-text-search",
  ],
  insforge: [
    "https://docs.insforge.dev/agent-native/overview",
    "https://docs.insforge.dev/mcp-setup",
    "https://docs.insforge.dev/core-concepts/database/migrations",
    "https://docs.insforge.dev/core-concepts/database/pgvector",
  ],
  neon: [
    "https://neon.com/docs/connect/query-with-psql-editor",
    "https://neon.com/docs/manage/databases",
    "https://neon.com/docs/guides/row-level-security",
    "https://neon.com/docs/ai/ai-concepts",
  ],
  nile: [
    "https://www.thenile.dev/docs/cli/interacting_db",
    "https://www.thenile.dev/docs/getting-started/languages/sql",
    "https://www.thenile.dev/docs/extensions/vector",
    "https://www.thenile.dev/docs/extensions/pg_bigm",
  ],
  turso: [
    "https://docs.turso.tech/tursodb/quickstart",
    "https://docs.turso.tech/cli/db/shell",
    "https://docs.turso.tech/sql-reference/statements/create-table",
    "https://docs.turso.tech/sql-reference/functions/fts",
    "https://docs.turso.tech/guides/vector-search",
  ],
  supabase: [
    "https://supabase.com/docs/guides/database/tables",
    "https://supabase.com/docs/guides/cli",
    "https://supabase.com/docs/guides/database/extensions/pgvector",
    "https://supabase.com/docs/guides/database/full-text-search",
  ],
};

const entries: Array<Record<string, unknown>> = [];
for (const [vendor, vendorUrls] of Object.entries(urls)) {
  for (const url of vendorUrls) {
    const retrievedAt = new Date().toISOString();
    try {
      const response = await fetch(url, { redirect: "follow" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      entries.push({
        vendor,
        url,
        final_url: response.url,
        status: response.status,
        ok: response.ok,
        content_type: response.headers.get("content-type"),
        etag: response.headers.get("etag"),
        last_modified: response.headers.get("last-modified"),
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        retrieved_at: retrievedAt,
      });
    } catch (error) {
      entries.push({ vendor, url, ok: false, status: 0, error: String(error), retrieved_at: retrievedAt });
    }
  }
}

const out = resolve("ax-arena/benchmark/axarena-database/v2-1/docs-snapshot-manifest.yaml");
mkdirSync(resolve(out, ".."), { recursive: true, mode: 0o700 });
writeFileSync(out, stringify({
  schema: "ax.daeb-v2-1-doc-snapshot/v1",
  generated_at: new Date().toISOString(),
  purpose: "Reachability and content hashes for official CLI/data-plane authoring sources; no prompt or secret data.",
  entries,
}), { mode: 0o600 });
console.log(`Wrote ${entries.length} official-doc snapshot entries → ${out}`);
console.log(`HTTP failures: ${entries.filter((entry) => entry.ok !== true).length}`);
