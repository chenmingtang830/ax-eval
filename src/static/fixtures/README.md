# Static-audit fixtures

Saved sample responses so the static audit (and its tests) run offline. The
fetcher (`../fetcher.ts`) reads a file here when run in `fixture` mode, or when a
live fetch fails and fallback is enabled.

Filename = the URL's host + path (+ query), flattened: every char outside
`[A-Za-z0-9._-]` becomes `_` (see `fixtureName` in `fetcher.ts`). The root path
maps to a reserved `__root__` segment so it can't collide with a literal
`/index`. No extension is forced, so the URL keeps its own. A missing file is a
404 — in offline mode that's a genuine absence; on live-fetch fallback a missing
fixture instead surfaces as a network error (the check is "not evaluated"):

- `asana.com_llms.txt` → `https://asana.com/llms.txt`
- `asana.com_openapi.json` → `https://asana.com/openapi.json`
- `asana.com___root__` → `https://asana.com/` (root)

These are illustrative samples for the demo, not a live snapshot of any site.
