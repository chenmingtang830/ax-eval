import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";

const repo = resolve(new URL("../../..", import.meta.url).pathname);
const sourcePath = resolve(repo, "ax-arena/benchmark/axarena-database/v1/packs/supabase/pack.yaml");
const outputRoot = resolve(repo, "ax-arena/benchmark/axarena-database/v2/production/extensions/supabase-cli");
const source = parse(readFileSync(sourcePath, "utf8")) as Record<string, any>;

const cliContract = [
  "",
  "SUPABASE CLI-ONLY EXTENSION CONTRACT: This extension admits exactly one surface: the PostgreSQL data plane through the declared `psql` command-line tool and `process.env.SUPABASE_DB_URL`.",
  "Do not use Supabase REST/PostgREST, dashboard actions, Supabase control-plane API calls, SDKs, or a local database. Use `psql` for discovery, DDL, DML, and read-back. Keep credentials out of output. The independent verifier reads the same hosted Postgres database through its own SQL connection, and the namespaced reset provider runs after verification.",
  "The task is not admitted by a successful command alone: setup, mutation, independent read-back, and hash-bound witness evidence are required. Never delete or reset resources outside the exact task namespace.",
  "",
].join("\n");

function removeApiInstructions(prompt: string): string {
  return prompt
    .replace(/\n\nSupabase API data-plane contract:[\s\S]*?(?=\n\n(?:Strict access-control verifier contract|SQL write lifecycle contract))/g, "")
    .replace(/\n\nSupabase API data-plane contract:[\s\S]*$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const tasks = (source.tasks as Array<Record<string, any>>).map((task) => ({
  ...task,
  prompt: `${removeApiInstructions(String(task.prompt))}${cliContract}`.trim(),
  allowed_surfaces: ["cli"],
  na: false,
}));

const pack = {
  name: "supabase",
  version: "2-cli-extension",
  standard_set_version: "daeb-2-cli-extension-v1",
  run_id: "d2x-supa",
  generated_by: "v2-cli-extension-derivation",
  generator: {
    harness: "deterministic",
    model: "none",
    effort: "high",
    prompt_version: "compose-pack-supabase-cli-extension-v1",
    source_docs: [
      "https://supabase.com/docs/guides/database/psql",
      "https://supabase.com/docs/guides/database/connecting-to-postgres",
      "https://supabase.com/docs/guides/database/postgres/row-level-security",
      "https://supabase.com/docs/guides/ai/vector-columns",
      "https://supabase.com/docs/guides/database/full-text-search",
    ],
  },
  auth_method: "sql-connection",
  api_style: "rest",
  auth: { type: "none", env: "", env_aliases: [], verify_env_aliases: [] },
  sandbox_scope: [],
  sql_conn: { dialect: "postgres", connection_string_env: "SUPABASE_DB_URL" },
  surfaces: {
    cli: {
      bin: "psql",
      install: "Install PostgreSQL client tools (psql).",
      docs_url: "https://supabase.com/docs/guides/database/psql",
      auth: {
        kind: "inherit",
        token_env_aliases: [],
        instructions: "Use SUPABASE_DB_URL with psql for hosted PostgreSQL data-plane operations. Supabase REST and control-plane APIs are out of scope for this CLI-only extension.",
      },
    },
  },
  base_url: "",
  headers: {},
  site_url: "https://supabase.com",
  openapi_url: "",
  docs_urls: [
    "https://supabase.com/docs/guides/database/psql",
    "https://supabase.com/docs/guides/database/connecting-to-postgres",
    "https://supabase.com/docs/guides/database/postgres/row-level-security",
    "https://supabase.com/docs/guides/ai/vector-columns",
    "https://supabase.com/docs/guides/database/full-text-search",
  ],
  static: {
    site_url: "https://supabase.com",
    docs_urls: [
      "https://supabase.com/docs/guides/database/psql",
      "https://supabase.com/docs/guides/database/connecting-to-postgres",
      "https://supabase.com/docs/guides/database/postgres/row-level-security",
      "https://supabase.com/docs/guides/ai/vector-columns",
      "https://supabase.com/docs/guides/database/full-text-search",
    ],
    checks: [],
  },
  discovery: {
    product: "Supabase",
    goal: "Operate Supabase from a cold start through its documented PostgreSQL CLI data plane. Discover psql, the connection-string contract, and one live SQL read/write before attempting the tasks. This extension is CLI-only; do not call Supabase REST or control-plane APIs.",
    official_domains: ["supabase.com"],
    canonical_endpoint: "psql with SUPABASE_DB_URL",
    deprecated_markers: [],
    auth_scheme: "SQL connection string via the declared CLI",
  },
  tasks,
};

mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
writeFileSync(resolve(outputRoot, "pack.yaml"), stringify(pack), { mode: 0o600 });
console.log(`Wrote ${outputRoot}/pack.yaml`);
