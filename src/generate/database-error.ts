export function safeDatabaseError(error: unknown, connectionString: string): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutExactConnection = connectionString
    ? raw.split(connectionString).join("<redacted-connection>")
    : raw;
  const redacted = withoutExactConnection.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi,
    "$1<redacted>@",
  );
  return new Error(redacted);
}
