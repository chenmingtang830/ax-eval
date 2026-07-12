/**
 * Session hygiene for SQL-family sandboxes between DAEB tasks.
 * After ACL tasks that SET ROLE, later tasks must not inherit the denied role.
 */
import type { TargetPack } from "../schemas.js";
import { resolveSqlConn, runSqlCheck } from "./sql-verify.js";

/** True when a task's oracles use verifier SET ROLE (ACL deny probe). */
export function taskUsesSqlRole(pack: TargetPack, taskId: string): boolean {
  const task = pack.tasks.find((t) => t.id === taskId);
  return Boolean(task?.oracles.some((o) => o.sqlRoleTemplate || o.sqlRoleField));
}

/** Best-effort RESET ROLE on a fresh postgres connection after ACL work. */
export async function resetSqlSession(pack: TargetPack): Promise<void> {
  const conn = resolveSqlConn(pack);
  if (!conn || conn.dialect !== "postgres") return;
  await runSqlCheck(conn, "RESET ROLE");
}
