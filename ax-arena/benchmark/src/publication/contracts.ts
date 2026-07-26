import { z } from "zod";

const ArtifactPathSchema = z.string().min(1).max(4_096);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const ArtifactSchema = z.object({
  vendor_card: ArtifactPathSchema.optional(),
  oracle_extract: ArtifactPathSchema.optional(),
  compiled_pack: ArtifactPathSchema.optional(),
  approval: ArtifactPathSchema.optional(),
  support_matrix: ArtifactPathSchema.optional(),
  snapshot: ArtifactPathSchema.optional(),
  snapshots: z.array(ArtifactPathSchema).optional(),
  report_html: ArtifactPathSchema.optional(),
  report_htmls: z.array(ArtifactPathSchema).optional(),
  normalized_records: z.array(ArtifactPathSchema),
}).strict();

const PublicationLayerSchema = z.object({
  description: z.string(),
  methodology_artifacts: z.array(ArtifactPathSchema),
}).strict();

const HostedAttestationSchema = z.object({
  schema: z.literal("ax.github-oidc-attestation-verification/v1"),
  subject_path: ArtifactPathSchema,
  subject_sha256: Sha256Schema,
  detached_bundles_path: ArtifactPathSchema,
  detached_bundles_sha256: Sha256Schema,
  repository: z.literal("chenmingtang830/ax-eval"),
  signer_workflow: z.literal("chenmingtang830/ax-eval/.github/workflows/trusted-sandbox-records.yml"),
  workflow_ref: z.literal("chenmingtang830/ax-eval/.github/workflows/trusted-sandbox-records.yml@refs/heads/main"),
  workflow_sha: z.string().regex(/^[a-f0-9]{40}$/),
  run_id: z.string().regex(/^\d+$/),
  run_attempt: z.string().regex(/^[1-9]\d*$/),
}).strict();

export const PUBLICATION_INTEGRITY_SCHEMA = "ax.publication-integrity/v1" as const;

export const ArenaPublicationIntegritySchema = z.object({
  schema: z.literal(PUBLICATION_INTEGRITY_SCHEMA),
  source_commit_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  batch_id: z.string().min(1).regex(/\S/),
  configuration_hash: Sha256Schema,
  batch_manifest_path: ArtifactPathSchema,
  batch_manifest_sha256: Sha256Schema,
  batch_completion_path: ArtifactPathSchema,
  batch_completion_sha256: Sha256Schema,
  runtime_report_path: ArtifactPathSchema,
  runtime_report_sha256: Sha256Schema,
  attestation: HostedAttestationSchema,
  files: z.array(z.object({
    path: ArtifactPathSchema,
    sha256: Sha256Schema,
    bytes: z.number().int().nonnegative().safe(),
    source_path: ArtifactPathSchema.optional(),
  }).strict()).min(1),
}).strict().superRefine((integrity, context) => {
  const paths = integrity.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", path: ["files"], message: "integrity file paths must be unique" });
  }
  if (paths.some((path, index) => index > 0 && paths[index - 1]! >= path)) {
    context.addIssue({ code: "custom", path: ["files"], message: "integrity files must be canonically sorted" });
  }
});
export type ArenaPublicationIntegrity = z.infer<typeof ArenaPublicationIntegritySchema>;

/** Arena exports are publication artifacts, so the integrity envelope is
 * mandatory. Historical unsealed v2 bundles remain readable only by legacy
 * core tooling and cannot be promoted through the arena publication path. */
export const ArenaPublicationBundleSchema = z.object({
  schema: z.literal("ax.publication-bundle/v2"),
  benchmark: z.string().min(1),
  category: z.string().min(1),
  suite: ArtifactPathSchema,
  suite_version: z.number().int().nonnegative(),
  generated_at: z.string().datetime({ offset: true }),
  publication_readiness: z.literal("publication_ready"),
  expected_matrix: z.object({
    surfaces: z.array(z.string()),
    harnesses: z.array(z.string()),
    effort_profiles: z.array(z.string()),
    required_effort_profiles: z.array(z.string()),
    expected_cells: z.number().int().nonnegative(),
  }).strict(),
  quality_gates: z.array(z.object({
    id: z.string(),
    label: z.string(),
    status: z.enum(["pass", "warn", "fail"]),
    detail: z.string(),
  }).strict()),
  layers: z.object({
    static_ax: PublicationLayerSchema,
    behavioral: PublicationLayerSchema,
  }).strict(),
  vendors: z.array(z.object({
    slug: z.string().min(1),
    pack: ArtifactPathSchema,
    expected_surfaces: z.array(z.enum(["api", "cli", "sdk", "mcp"])).min(1).max(4),
    missing: z.array(ArtifactPathSchema),
    validation_errors: z.array(z.string()),
    artifacts: ArtifactSchema,
  }).strict()),
  competitive_report: ArtifactPathSchema,
  missing: z.array(ArtifactPathSchema),
  notes: z.array(z.string()),
  integrity: ArenaPublicationIntegritySchema,
}).strict();
export type ArenaPublicationBundle = z.infer<typeof ArenaPublicationBundleSchema>;

/** Direct manifest references whose bytes affect the publication export.
 * Nested cell/source/evidence references are discovered from verified JSON and
 * required separately. `manifest.json` is excluded because embedding its own
 * digest would be self-referential. */
export function publicationArtifactPaths(bundle: ArenaPublicationBundle): string[] {
  const paths = [
    bundle.integrity.batch_manifest_path,
    bundle.integrity.batch_completion_path,
    bundle.integrity.runtime_report_path,
    bundle.integrity.attestation.subject_path,
    bundle.integrity.attestation.detached_bundles_path,
    bundle.suite,
    ...bundle.layers.static_ax.methodology_artifacts,
    ...bundle.layers.behavioral.methodology_artifacts,
    ...(bundle.competitive_report ? [bundle.competitive_report] : []),
  ];
  for (const vendor of bundle.vendors) {
    const artifacts = vendor.artifacts;
    paths.push(...[
      artifacts.vendor_card,
      artifacts.oracle_extract,
      artifacts.compiled_pack,
      artifacts.approval,
      artifacts.support_matrix,
      artifacts.snapshot,
      artifacts.report_html,
    ].filter((item): item is string => typeof item === "string"));
    paths.push(
      ...(artifacts.snapshots ?? []),
      ...(artifacts.report_htmls ?? []),
      ...artifacts.normalized_records,
    );
  }
  return [...new Set(paths)];
}
