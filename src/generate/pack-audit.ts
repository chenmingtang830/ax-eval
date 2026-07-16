import { isDeepStrictEqual } from "node:util";
import type { TargetPack } from "../schemas.js";
import { composePack } from "./compose-pack.js";
import type { PackComposeConfig } from "./pack-compose-config.js";
import type { Suite } from "./suite.js";
import type { SurfaceExtractResult } from "./surface-extract.js";
import type { TaskExtractResult } from "./task-extract.js";
import type { ResolveResult } from "./vendor-resolve.js";

export interface ComposedPackAuditInput {
  pack: TargetPack;
  vendor: ResolveResult;
  suite: Suite;
  surfaces: SurfaceExtractResult;
  tasks: TaskExtractResult;
  config: PackComposeConfig;
}

export interface PackAuditFinding {
  severity: "error";
  code:
    | "pack_identity_drift"
    | "pack_config_drift"
    | "pack_surface_drift"
    | "pack_provenance_drift"
    | "pack_task_set_drift"
    | "pack_task_content_drift"
    | "sandbox_scope_unbound";
  message: string;
}

const IDENTITY_FIELDS = ["name", "version", "standard_set_version"] as const;
const CONFIG_FIELDS = [
  "api_style",
  "auth_method",
  "auth",
  "sandbox_scope",
  "sql_conn",
  "mongo_conn",
  "base_url",
  "request_envelope",
  "response_envelope",
  "headers",
  "field_select_param",
  "site_url",
  "docs_urls",
  "discovery",
  "static",
] as const;

function artifactValue(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function artifactEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(artifactValue(left), artifactValue(right));
}

function changedFields(
  actual: TargetPack,
  expected: TargetPack,
  fields: readonly (keyof TargetPack)[],
): string[] {
  return fields.filter((field) => !artifactEqual(actual[field], expected[field]));
}

function taskIds(pack: TargetPack): string[] {
  return pack.tasks.map((task) => task.id);
}

function taskContentDrift(actual: TargetPack, expected: TargetPack): string[] {
  const actualById = new Map(actual.tasks.map((task) => [task.id, task]));
  return expected.tasks.flatMap((task) => {
    const candidate = actualById.get(task.id);
    return candidate && !artifactEqual(candidate, task) ? [task.id] : [];
  });
}

function surfaceInstructions(pack: TargetPack): string {
  return Object.values(pack.surfaces ?? {})
    .filter((surface): surface is NonNullable<typeof surface> => Boolean(surface))
    .map((surface) => surface.auth?.instructions ?? "")
    .join("\n");
}

function unboundSandboxScopes(pack: TargetPack): string[] {
  const authoringText = `${pack.tasks.map((task) => task.prompt).join("\n")}\n${surfaceInstructions(pack)}`;
  return pack.sandbox_scope.filter((scope) => !authoringText.includes(scope.env)).map((scope) => scope.name);
}

export function auditComposedPack(input: ComposedPackAuditInput): PackAuditFinding[] {
  const expected = composePack(input.vendor, input.suite, input.surfaces, input.tasks, input.config, {
    now: () => new Date("2000-01-01T00:00:00.000Z"),
    generatedBy: input.pack.generated_by,
  });
  const findings: PackAuditFinding[] = [];

  const identityFields = changedFields(input.pack, expected, IDENTITY_FIELDS);
  if (identityFields.length > 0) {
    findings.push({
      severity: "error",
      code: "pack_identity_drift",
      message: `Composed pack identity fields drifted: ${identityFields.join(", ")}`,
    });
  }

  const configFields = changedFields(input.pack, expected, CONFIG_FIELDS);
  if (configFields.length > 0) {
    findings.push({
      severity: "error",
      code: "pack_config_drift",
      message: `Composed pack configuration fields drifted: ${configFields.join(", ")}`,
    });
  }

  if (!artifactEqual(input.pack.surfaces, expected.surfaces)) {
    findings.push({
      severity: "error",
      code: "pack_surface_drift",
      message: "Composed pack surfaces drifted from the reviewed surface extract and compose configuration",
    });
  }

  if (!artifactEqual(input.pack.generator, expected.generator)) {
    findings.push({
      severity: "error",
      code: "pack_provenance_drift",
      message: "Composed pack generator provenance drifted from the reviewed authoring inputs",
    });
  }

  const actualIds = taskIds(input.pack);
  const expectedIds = taskIds(expected);
  if (!isDeepStrictEqual(actualIds, expectedIds)) {
    findings.push({
      severity: "error",
      code: "pack_task_set_drift",
      message: `Composed pack task order or membership drifted: expected [${expectedIds.join(", ")}], got [${actualIds.join(", ")}]`,
    });
  }

  const changedTasks = taskContentDrift(input.pack, expected);
  if (changedTasks.length > 0) {
    findings.push({
      severity: "error",
      code: "pack_task_content_drift",
      message: `Composed pack task content drifted for: ${changedTasks.join(", ")}`,
    });
  }

  const unboundScopes = unboundSandboxScopes(input.pack);
  if (unboundScopes.length > 0) {
    findings.push({
      severity: "error",
      code: "sandbox_scope_unbound",
      message: `Sandbox scopes are not referenced by task prompts or surface instructions: ${unboundScopes.join(", ")}`,
    });
  }
  return findings;
}
