/**
 * Shared JSON parsers for agent-authored result files.
 *
 * Shell-style `\'` escapes inside JSON strings are recovered (agents often
 * paste psql -c quoting). Bare unescaped inner quotes are NOT recovered —
 * those used to score Turso (and similar) passes on illegally repaired JSON.
 */
export function retryWithShellQuoteRecovery(text: string): string {
  return text.replace(/\\'/g, "'");
}

/** Parse JSON; retry once after stripping invalid shell `\'` escapes only. */
export function parseJsonWithRecovery<T = unknown>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const shellRecovered = retryWithShellQuoteRecovery(text);
    if (shellRecovered === text) throw error;
    return JSON.parse(shellRecovered) as T;
  }
}
