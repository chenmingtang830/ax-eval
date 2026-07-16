import { existsSync } from "node:fs";
import { loadPack } from "../config.js";
import { daebCompiledPackPath } from "./benchmark-paths.js";
import type { OracleExtractResult } from "./task-extract.js";
import type { SupportMatrix } from "./methodology.js";

export interface PackAuditFinding {
  severity: "error" | "warn";
  code: "sandbox_scope_unbound" | "sandbox_oracle_env_drift" | "support_matrix_pack_drift";
  message: string;
}

/** Audit the composed (not yet approved) pack against its upstream contracts. */
export function auditComposedPack(
  packPath: string,
  extract: OracleExtractResult,
  supportMatrix: SupportMatrix,
): PackAuditFinding[] {
  if (!existsSync(packPath)) return [];
  const pack = loadPack(packPath);
  const findings: PackAuditFinding[] = [];
  if (pack.auth?.env !== extract.vendor_config.auth_env) {
    findings.push({
      severity: "error",
      code: "sandbox_oracle_env_drift",
      message: `Pack auth env ${pack.auth?.env ?? "<none>"} differs from oracle extract ${extract.vendor_config.auth_env}`,
    });
  }
  if (pack.sql_conn?.connection_string_env !== extract.vendor_config.sql_connection_env) {
    findings.push({
      severity: "error",
      code: "sandbox_oracle_env_drift",
      message: `Pack SQL env ${pack.sql_conn?.connection_string_env ?? "<none>"} differs from oracle extract ${extract.vendor_config.sql_connection_env ?? "<none>"}`,
    });
  }
  const promptText = pack.tasks.map((task) => task.prompt).join("\n");
  for (const scope of pack.sandbox_scope) {
    const surfaceText = Object.values(pack.surfaces ?? {})
      .filter((surface): surface is NonNullable<typeof surface> => Boolean(surface))
      .map((surface) => surface.auth?.instructions ?? "")
      .join("\n");
    if (!promptText.includes(scope.env) && !surfaceText.includes(scope.env)) {
      findings.push({
        severity: "error",
        code: "sandbox_scope_unbound",
        message: `Sandbox env ${scope.env} is declared but absent from task prompts and surface instructions`,
      });
    }
  }
  for (const task of pack.tasks) {
    const expected = supportMatrix.entries
      .filter((entry) => entry.vendor === extract.vendor && entry.task_id === task.id && entry.status === "supported")
      .map((entry) => entry.surface)
      .sort();
    const actual = [...task.allowed_surfaces].sort();
    if (expected.join(",") !== actual.join(",")) {
      findings.push({
        severity: "error",
        code: "support_matrix_pack_drift",
        message: `${task.id} pack surfaces [${actual.join(",")}] differ from support matrix [${expected.join(",")}]`,
      });
    }
  }
  return findings;
}

export function auditCorePacks(
  root: string,
  slugs: string[],
  extracts: Map<string, OracleExtractResult>,
  supportMatrix: SupportMatrix,
): PackAuditFinding[] {
  return slugs.flatMap((slug) => {
    const extract = extracts.get(slug);
    return extract
      ? auditComposedPack(daebCompiledPackPath(root, slug), extract, supportMatrix)
      : [];
  });
}
