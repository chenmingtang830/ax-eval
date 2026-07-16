export type DatabaseCheckPhase = "validate" | "connect" | "transaction" | "role" | "query" | "cleanup";

export class DatabaseCheckError extends Error {
  readonly code?: string;
  readonly errno?: number;
  readonly sqlState?: string;
  readonly phase?: DatabaseCheckPhase;

  constructor(message: string, details: {
    code?: string;
    errno?: number;
    sqlState?: string;
    phase?: DatabaseCheckPhase;
  }) {
    super(message);
    this.name = "DatabaseCheckError";
    this.code = details.code;
    this.errno = details.errno;
    this.sqlState = details.sqlState;
    this.phase = details.phase;
  }
}

export function safeDatabaseError(
  error: unknown,
  connectionString: string,
  phase?: DatabaseCheckPhase,
): DatabaseCheckError {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutExactConnection = connectionString
    ? raw.split(connectionString).join("<redacted-connection>")
    : raw;
  const redacted = withoutExactConnection.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi,
    "$1<redacted>@",
  );
  const details = error && typeof error === "object" ? error as {
    code?: unknown;
    errno?: unknown;
    sqlState?: unknown;
  } : {};
  return new DatabaseCheckError(redacted, {
    code: typeof details.code === "string" ? details.code : undefined,
    errno: typeof details.errno === "number" ? details.errno : undefined,
    sqlState: typeof details.sqlState === "string" ? details.sqlState : undefined,
    phase,
  });
}
