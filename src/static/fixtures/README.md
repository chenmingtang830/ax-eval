# Static-audit fixtures

Saved sample responses so the static audit (and its tests) run offline. The
fetcher (`../fetcher.ts`) reads a file here when run in `fixture` mode, or when a
live fetch fails and fallback is enabled.

Filename = the URL's host + path, flattened: every char outside `[A-Za-z0-9._-]`
becomes `_` (see `fixtureName` in `fetcher.ts`). No extension is forced, so the
URL keeps its own. A missing file is treated as a 404 (the surface is absent):

- `asana.com_llms.txt` → `https://asana.com/llms.txt`
- `asana.com_openapi.json` → `https://asana.com/openapi.json`
- `asana.com_index` → `https://asana.com/` (root)

These are illustrative samples for the demo, not a live snapshot of any site.
