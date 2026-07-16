/** Recover the shell-style single-quote escapes agents commonly copy from commands. */
export function retryWithShellQuoteRecovery(text: string): string {
  return text.replace(/\\'/g, "'");
}

/** Parse JSON, retrying only the narrow shell-quote recovery above. */
export function parseJsonWithRecovery<T = unknown>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const recovered = retryWithShellQuoteRecovery(text);
    if (recovered === text) throw error;
    return JSON.parse(recovered) as T;
  }
}
