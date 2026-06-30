/**
 * Compose a TargetPack from a canonical Suite + a vendor's OracleExtract +
 * vendor card. Pure code — no LLM. Every per-vendor unknown (oracle paths,
 * base_url, auth) was already resolved by resolve-vendor / extract-oracles;
 * this step is template rendering + schema assembly.
 *
 * Task prompt text comes straight from the suite's `intent` field — it's
 * already vendor-agnostic goal language ("use the vendor's idiomatic
 * mechanism"), so no per-vendor rewriting is needed or wanted: the agent is
 * supposed to discover the concrete mechanism itself.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { newRunId, NS_PLACEHOLDER } from "./pack.js";
import type { Suite } from "./suite.js";
import type { ResolveResult } from "./vendor-resolve.js";
import type { OracleExtractResult } from "./task-extract.js";
import { TargetPackSchema, type TargetPack } from "../schemas.js";

export interface ComposePackOptions {
  /** Generation provenance label recorded on the pack. */
  generatedBy?: string;
}

/** Compose one vendor's frozen TargetPack from suite + oracle extract + vendor card. */
export function composePack(
  suite: Suite,
  vendor: ResolveResult,
  extract: OracleExtractResult,
  opts: ComposePackOptions = {},
): TargetPack {
  const extractByTaskId = new Map(extract.tasks.map((t) => [t.task_id, t]));

  const tasks = suite.tasks.map((suiteTask) => {
    const o = extractByTaskId.get(suiteTask.id);
    if (!o) {
      throw new Error(`compose-pack: oracle extract for "${vendor.vendor}" is missing task "${suiteTask.id}"`);
    }
    const prompt = suiteTask.intent.trim().replace(/\{ns\}/g, NS_PLACEHOLDER);
    if (o.na) {
      return {
        id: suiteTask.id,
        title: suiteTask.title,
        prompt,
        difficulty: suiteTask.difficulty,
        allowed_surfaces: [],
        // No surfaces means this task never executes; the reason is recorded
        // here (TaskSchema has no dedicated na_reason field) for the
        // methodology page's N/A disclosure table.
        oracles: [{ type: "na", description: o.na_reason ?? "marked N/A by oracle extract" }],
      };
    }
    return {
      id: suiteTask.id,
      title: suiteTask.title,
      prompt,
      difficulty: suiteTask.difficulty,
      allowed_surfaces: suiteTask.allowed_surfaces,
      oracles: [
        {
          type: "roundtrip",
          description: suiteTask.oracle_hint.trim(),
          readMethod: o.read_method ?? "GET",
          readPathTemplate: o.read_path_template?.replace(/\{ns\}/g, NS_PLACEHOLDER),
          assertField: o.assert_field,
        },
      ],
    };
  });

  const pack = {
    name: vendor.slug,
    version: "1",
    standard_set_version: `${suite.name.toLowerCase()}-v${suite.version}`,
    run_id: newRunId(),
    generated_by: opts.generatedBy ?? "suite-composed",
    generator: {
      harness: extract.vendor_config ? "claude-code" : "host-agent",
      model: "host-default",
      effort: "high" as const,
      prompt_version: "compose-pack-v1",
      source_docs: [vendor.docs_url ?? ""].filter(Boolean),
    },
    api_style: "rest" as const,
    auth_method: "pat" as const,
    auth: {
      type: extract.vendor_config.auth_type,
      env: extract.vendor_config.auth_env,
      env_aliases: [],
      verify_env_aliases: [],
      header: extract.vendor_config.auth_header,
    },
    sandbox_scope: [],
    base_url: extract.vendor_config.base_url,
    headers: {},
    site_url: vendor.site_url ?? "",
    docs_urls: vendor.docs_url ? [vendor.docs_url] : [],
    static: {
      site_url: vendor.site_url ?? "",
      docs_urls: vendor.docs_url ? [vendor.docs_url] : [],
      checks: [],
    },
    tasks,
  };

  return TargetPackSchema.parse(pack);
}

/** Path where a composed pack is written. */
export function composedPackPath(root: string, slug: string, suiteName: string): string {
  return resolve(root, "targets", "packs", slug, `${suiteName.toLowerCase()}.yaml`);
}

/** Write a composed pack to disk as YAML. */
export function writeComposedPack(root: string, slug: string, suiteName: string, pack: TargetPack): string {
  const path = composedPackPath(root, slug, suiteName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `# GENERATED — frozen standard_set. Do not hand-edit task ids/oracles after freeze.\n` +
      `# generated_by: ${pack.generated_by}\n` +
      `# standard_set_version: ${pack.standard_set_version}\n` +
      `# run_id: ${pack.run_id}\n` +
      yamlStringify(pack),
  );
  return path;
}
