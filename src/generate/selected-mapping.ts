export function parseSelectedMappings(
  entries: readonly string[],
  selectedSlugs: readonly string[],
  flag: string,
): Map<string, string> {
  const selected = new Set(selectedSlugs);
  const mappings = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const slug = separator < 0 ? "" : entry.slice(0, separator).trim();
    const source = separator < 0 ? "" : entry.slice(separator + 1).trim();
    if (!slug || !source) throw new Error(`${flag} expects <slug>=<source>`);
    if (!selected.has(slug)) throw new Error(`${flag} names unselected vendor ${slug}`);
    if (mappings.has(slug)) throw new Error(`duplicate ${flag} for ${slug}`);
    mappings.set(slug, source);
  }
  return mappings;
}
