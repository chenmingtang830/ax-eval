import type { Task } from "../schemas.js";
import type { GenerateOptions } from "../generate/pack.js";
import type { GenerateGraphqlPackOptions } from "../generate/graphql-pack.js";

export interface GeneratePreset<TOptions> {
  id: string;
  options: Partial<TOptions>;
  /** Guidance for the LLM authoring pass. These hints steer fuzzy planning but
   *  never replace the programmatic seed/validator path. */
  authoringHints?: string[];
  /** Whether the auto-expanded generated.full preset should apply. */
  allowFullPreset?: boolean;
  /** Optional default output override for generate. */
  defaultOut?: string;
  /** Some shipped presets keep a different follow-up review hint. */
  skipReviewReminder?: boolean;
}

function normalizeProduct(product: string): string {
  return product.trim().toLowerCase();
}

/**
 * Curated, Asana-specific generation extras. Asana's OpenAPI declares no
 * `securitySchemes` and several resources read back under `title` not `name`,
 * so these can't be derived from the spec — they're hand-curated for the Asana
 * target. Layered on ONLY when the product resolves to Asana; every other
 * product generates generically from the ingested spec.
 */
const ASANA_PRESET: GeneratePreset<GenerateOptions> = {
  id: "asana",
  defaultOut: "targets/asana/generated.pack.yaml",
  skipReviewReminder: true,
  authoringHints: [
    "Keep Asana auth env names stable: ASANA_PAT for runtime auth and ASANA_VERIFY_PAT for verification.",
    "Prefer workspace-safe objects such as tasks, projects, tags, goals, portfolios, sections, project briefs, and project statuses.",
    "Preserve the hand-curated L4 state-mutation tasks for complete/reschedule/archive flows unless the seed is clearly impossible.",
    "When improving prompts, keep them goal-level and avoid leaking endpoint names.",
  ],
  options: {
    packName: "asana-generated",
    siteUrl: "https://developers.asana.com",
    openapiUrl: "https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml",
    docsUrls: ["https://developers.asana.com/docs"],
    authMethod: "pat",
    authScheme: "Bearer personal access token",
    authType: "bearer",
    authEnv: "ASANA_PAT",
    authVerifyEnv: "ASANA_VERIFY_PAT",
    prefer: [
      "tasks", "projects", "tags", "goals", "portfolios",
      "sections", "project_briefs", "project_statuses", "stories",
    ],
    identityOverrides: {
      project_briefs: "title",
      project_statuses: "title",
    },
    surfaces: {
      sdk: {
        package: "asana",
        language: "node",
        reference_url: "https://developers.asana.com/docs/overview",
        auth: { kind: "inherit", token_env_aliases: [] },
      },
      mcp: {
        server: "https://mcp.asana.com/v2/mcp",
        transport: "http",
        args: [],
        docs_url: "https://developers.asana.com/docs/using-asanas-mcp-server",
        auth: {
          kind: "oauth_app",
          token_env_aliases: [],
          client_id_env: "ASANA_MCP_CLIENT_ID",
          client_secret_env: "ASANA_MCP_CLIENT_SECRET",
          refresh_token_env: "ASANA_MCP_REFRESH_TOKEN",
          token_url: "https://app.asana.com/-/oauth_token",
          instructions:
            "Register an Asana OAuth app, complete the OAuth flow once, and store the refresh token. ax-eval exchanges it for a short-lived MCP bearer token at invoke time.",
        },
      },
    },
    l4: [
      {
        idSuffix: "task-complete",
        title: "L4: create then complete a task (state mutation)",
        resource: "tasks",
        prompt:
          `Create a task named "{val}", then mark it complete. Report the task id; ` +
          `it must read back as completed.`,
        assertField: "completed",
        expected: true,
      },
      {
        idSuffix: "task-reschedule",
        title: "L4: create then reschedule a task (due-date mutation)",
        resource: "tasks",
        prompt:
          `Create a task named "{val}", then set its due date to 2026-06-30. ` +
          `Report the task id.`,
        assertField: "due_on",
        expected: "2026-06-30",
      },
      {
        idSuffix: "project-archive",
        title: "L4: create then archive a project (state mutation)",
        resource: "projects",
        prompt:
          `Create a project named "{val}" in the sandbox workspace, then archive it. ` +
          `Report the project id; it must read back as archived.`,
        assertField: "archived",
        expected: true,
      },
    ],
  },
};

const exaUrlOracleTrace = (description: string): NonNullable<GenerateOptions["operationTasks"]>[number]["trace"] => [
  { type: "required_call", method: "POST", path: "/search", description },
];

const EXA_PRESET: GeneratePreset<GenerateOptions> = {
  id: "exa",
  allowFullPreset: false,
  authoringHints: [
    "Exa's core API is operation-oriented, not CRUD. Preserve the curated POST /search and POST /contents tasks rather than trying to invent fake resource lifecycle tasks.",
    "Keep EXA_API_KEY and x-api-key stable; do not rename auth env vars or move auth into bearer form.",
    "Prefer official-source URL matching with expectedAny aliases for redirects, anchors, and versioned docs.",
  ],
  options: {
    packName: "exa",
    siteUrl: "https://exa.ai",
    openapiUrl: "https://docs.exa.ai/exa-spec.json",
    docsUrls: [
      "https://docs.exa.ai/reference/search-api-guide",
      "https://docs.exa.ai/reference/search-api-guide-for-coding-agents",
      "https://docs.exa.ai/reference/openapi-spec",
    ],
    authMethod: "api-key",
    authScheme: "API key in the x-api-key header",
    authType: "api-key",
    authEnv: "EXA_API_KEY",
    authHeader: "x-api-key",
    headers: {},
    sandboxScope: [],
    limit: 0,
    l2Limit: 0,
    l4Limit: 0,
    discoveryCanonicalEndpoint: "POST /search",
    discoveryGoal:
      "You are about to operate Exa programmatically. First work out, from scratch, how Exa's public Search API works — its base URL, how to authenticate with an API key in the `x-api-key` header, the `/search` request shape, and how content options such as `contents.highlights` are nested — then you will perform several tasks. You are NOT given any endpoint, base URL, or documentation link; find them yourself.",
    deprecatedMarkers: ["useAutoprompt", "includeUrls", "excludeUrls", "livecrawl"],
    surfaces: {
      sdk: {
        package: "exa-js",
        language: "node",
        reference_url: "https://docs.exa.ai/reference/typescript-sdk-specification",
        auth: { kind: "inherit", token_env_aliases: [] },
      },
      mcp: {
        server: "npx",
        args: ["-y", "exa-mcp-server"],
        transport: "stdio",
        docs_url: "https://docs.exa.ai/reference/exa-mcp",
        auth: {
          kind: "token",
          token_env: "EXA_API_KEY",
          token_env_aliases: [],
          instructions: "Configure the Exa MCP server with EXA_API_KEY. Verification still reads back through the Exa REST API.",
        },
      },
    },
    operationTasks: [
      {
        id: "exa-l1-python-taskgroup",
        title: "L1: find official Python docs",
        difficulty: "L1",
        prompt:
          "Use Exa Search to find the official Python documentation page for the `asyncio.TaskGroup` API. Request highlights via `contents.highlights`, and report the result URL `https://docs.python.org/3/library/asyncio-task.html` as the id if it is returned.",
        expectedUrl: "https://docs.python.org/3/library/asyncio-task.html",
        expectedAny: ["https://docs.python.org/3/library/asyncio-task.html#asyncio.TaskGroup"],
        matchMode: "url",
        trace: exaUrlOracleTrace("search must use Exa's Search endpoint"),
      },
      {
        id: "exa-l1-mdn-fetch",
        title: "L1: find MDN Fetch API docs",
        difficulty: "L1",
        prompt:
          "Use Exa Search to find MDN's Fetch API reference. Request highlights via `contents.highlights`, and report the result URL `https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API` as the id if it is returned.",
        expectedUrl: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
        matchMode: "url",
        trace: exaUrlOracleTrace("search must use Exa's Search endpoint"),
      },
      {
        id: "exa-l1-rfc-9110",
        title: "L1: find an RFC",
        difficulty: "L1",
        prompt:
          "Use Exa Search to find the HTML page for IETF RFC 9110, HTTP Semantics. Request highlights via `contents.highlights`, and report the result URL `https://www.rfc-editor.org/rfc/rfc9110.html` as the id if it is returned.",
        expectedUrl: "https://www.rfc-editor.org/rfc/rfc9110.html",
        expectedAny: ["https://www.rfc-editor.org/info/rfc9110/", "https://datatracker.ietf.org/doc/html/rfc9110"],
        matchMode: "url",
        trace: exaUrlOracleTrace("search must use Exa's Search endpoint"),
      },
      {
        id: "exa-l2-domain-filter-mdn",
        title: "L2: constrain search to one domain",
        difficulty: "L2",
        prompt:
          "Use Exa Search to find MDN's AbortController reference. Use `includeDomains` to restrict results to developer.mozilla.org and request `contents.highlights`. Report the result URL `https://developer.mozilla.org/en-US/docs/Web/API/AbortController` as the id if it is returned.",
        expectedUrl: "https://developer.mozilla.org/en-US/docs/Web/API/AbortController",
        matchMode: "url",
        trace: exaUrlOracleTrace("search must use Exa's Search endpoint"),
      },
      {
        id: "exa-l2-domain-filter-python",
        title: "L2: constrain search to Python docs",
        difficulty: "L2",
        prompt:
          "Use Exa Search to find Python's official `pathlib` documentation. Use `includeDomains` to restrict results to docs.python.org and request `contents.highlights`. Report the result URL `https://docs.python.org/3/library/pathlib.html` as the id if it is returned.",
        expectedUrl: "https://docs.python.org/3/library/pathlib.html",
        matchMode: "url",
        trace: exaUrlOracleTrace("search must use Exa's Search endpoint"),
      },
      {
        id: "exa-l2-exclude-domain",
        title: "L2: exclude a misleading domain",
        difficulty: "L2",
        prompt:
          "Use Exa Search to find the W3C WCAG 2.2 recommendation. Exclude misleading mirrors or explainers if they crowd out the official W3C result, request `contents.highlights`, and report the result URL `https://www.w3.org/TR/WCAG22/` as the id if it is returned.",
        expectedUrl: "https://www.w3.org/TR/WCAG22/",
        expectedAny: ["https://www.w3.org/TR/2023/REC-WCAG22-20231005/", "https://www.w3.org/TR/WCAG22/Overview.html"],
        matchMode: "url",
        trace: exaUrlOracleTrace("search must use Exa's Search endpoint"),
      },
      {
        id: "exa-l3-contents-readback-rfc",
        title: "L3: search then retrieve clean content",
        difficulty: "L3",
        prompt:
          "Use Exa Search to locate the IETF RFC 9110 HTTP Semantics page on rfc-editor.org, then use Exa Contents to retrieve clean content for the URL. Report the result URL `https://www.rfc-editor.org/rfc/rfc9110.html` as the id if it is returned.",
        expectedUrl: "https://www.rfc-editor.org/rfc/rfc9110.html",
        expectedAny: ["https://www.rfc-editor.org/info/rfc9110/", "https://datatracker.ietf.org/doc/html/rfc9110"],
        matchMode: "url",
        trace: [
          { type: "required_call", method: "POST", path: "/search", description: "first locate the page with Exa Search" },
          { type: "required_call", method: "POST", path: "/contents", description: "retrieve content for the located URL" },
        ],
      },
      {
        id: "exa-l3-summary-content",
        title: "L3: request per-result summaries",
        difficulty: "L3",
        prompt:
          "Use Exa Search to find the React documentation page for `useEffect`. Request `contents.summary` with a query focused on cleanup functions, and report the result URL `https://react.dev/reference/react/useEffect` as the id if it is returned.",
        expectedUrl: "https://react.dev/reference/react/useEffect",
        matchMode: "url",
        trace: exaUrlOracleTrace("search must request summary content"),
      },
      {
        id: "exa-l3-text-content-cap",
        title: "L3: retrieve capped text content",
        difficulty: "L3",
        prompt:
          "Use Exa Search to find the Node.js documentation page for `fsPromises`. Then use Exa Contents to retrieve text for the page with a character cap so the response stays small. Report the result URL `https://nodejs.org/api/fs.html` as the id if it is returned.",
        expectedUrl: "https://nodejs.org/api/fs.html",
        expectedAny: ["https://nodejs.org/docs/latest-v26.x/api/fs.html", "https://nodejs.org/dist/latest/docs/api/fs.html", "https://nodejs.org/api/fs.html#promises-api"],
        matchMode: "url",
        trace: [
          { type: "required_call", method: "POST", path: "/search", description: "first locate the page with Exa Search" },
          { type: "required_call", method: "POST", path: "/contents", description: "retrieve capped text content" },
        ],
      },
      {
        id: "exa-l4-structured-output-official-source",
        title: "L4: synthesize structured output from official sources",
        difficulty: "L4",
        prompt:
          "Use Exa Search with `outputSchema` to synthesize the official current Kubernetes documentation page for probes. Prefer official sources with a `systemPrompt`, request highlights, and report the source URL `https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/` as the id if it is returned in results or grounding.",
        expectedUrl: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/",
        expectedAny: ["https://kubernetes.io/docs/concepts/workloads/pods/probes/"],
        matchMode: "url",
        trace: exaUrlOracleTrace("search must use structured output"),
      },
      {
        id: "exa-l4-deep-comparison",
        title: "L4: deep search comparison",
        difficulty: "L4",
        prompt:
          "Use a deep Exa Search variant to compare official PostgreSQL documentation pages about transaction isolation levels. Prefer postgresql.org sources, request highlights, and report the result URL `https://www.postgresql.org/docs/current/transaction-iso.html` as the id if it is returned.",
        expectedUrl: "https://www.postgresql.org/docs/current/transaction-iso.html",
        expectedAny: ["https://www.postgresql.org/docs/18/transaction-iso.html"],
        matchMode: "url",
        trace: exaUrlOracleTrace("search must use a deep search variant"),
      },
      {
        id: "exa-l4-multi-angle-query",
        title: "L4: multi-angle search",
        difficulty: "L4",
        prompt:
          "Use Exa Search with a deep-capable search type and `additionalQueries` to find the official Cloudflare documentation page for cache rules. Use one query angle for \"cache rules\" and another for \"set cache eligibility\", and report the result URL `https://developers.cloudflare.com/cache/how-to/cache-rules/` as the id if it is returned.",
        expectedUrl: "https://developers.cloudflare.com/cache/how-to/cache-rules/",
        matchMode: "url",
        trace: exaUrlOracleTrace("search must use additional query angles"),
      },
    ],
  },
};

const CODA_CURATED_TASKS: Task[] = [
  {
    id: "coda-surface-l3-doc-goal",
    title: "L3: ambiguous goal-level — planning doc",
    difficulty: "L3",
    prompt:
      'A teammate says: "Please set up a fresh planning doc called \\"AX probe planning doc {ns}\\" for me in this workspace." Decide what object to create, create it, and report the created doc id as gid.',
    allowed_surfaces: ["api", "docs", "mcp"],
    na: false,
    create_path: "/docs",
    depends_on: [],
    trace: [],
    oracles: [
      {
        type: "roundtrip",
        description: "read the created planning doc back and assert its name",
        readPathTemplate: "/docs/{gid}",
        assertField: "name",
        expected: "AX probe planning doc {ns}",
      },
    ],
  },
  {
    id: "coda-api-l2-table-row-seeded",
    title: "L2: add a row to a real table-backed doc",
    difficulty: "L2",
    prompt:
      'Create or copy a doc that already contains a writable table whose identifying column is "Name", then add one row named "AX probe rows {ns}". If a brand-new empty doc has no tables, use another valid API path that yields a real table instead of inventing a table-creation endpoint. Report the row id as gid, the parent doc id as docId, and the target table id as tableIdOrName.',
    allowed_surfaces: ["api", "docs"],
    na: false,
    create_path: "/docs/{docId}/tables/{tableIdOrName}/rows",
    depends_on: [],
    trace: [],
    oracles: [
      {
        type: "roundtrip",
        description: "read the created row back and assert its display name",
        readPathTemplate: "/docs/{docId}/tables/{tableIdOrName}/rows/{gid}",
        assertField: "name",
        expected: "AX probe rows {ns}",
      },
    ],
  },
  {
    id: "coda-mcp-l1-page",
    title: "L1: create a page in a fresh doc",
    difficulty: "L1",
    prompt:
      'Create a new doc, then add one page named "AX probe mcp page {ns}". Report the page id as gid and the parent doc id as docId.',
    allowed_surfaces: ["api", "docs", "mcp"],
    na: false,
    create_path: "/docs/{docId}/pages",
    depends_on: [],
    trace: [],
    oracles: [
      {
        type: "roundtrip",
        description: "read the created page back and assert its name",
        readPathTemplate: "/docs/{docId}/pages/{gid}",
        assertField: "name",
        expected: "AX probe mcp page {ns}",
      },
    ],
  },
  {
    id: "coda-mcp-l1-page-subtitle",
    title: "L1: create a page with a subtitle",
    difficulty: "L1",
    prompt:
      'Create a new doc, then add one page named "AX probe mcp page-subtitle {ns}" with subtitle "AX probe subtitle {ns}". Report the page id as gid and the parent doc id as docId.',
    allowed_surfaces: ["api", "docs", "mcp"],
    na: false,
    create_path: "/docs/{docId}/pages",
    depends_on: [],
    trace: [],
    oracles: [
      {
        type: "roundtrip",
        description: "read the created page back and assert its subtitle",
        readPathTemplate: "/docs/{docId}/pages/{gid}",
        assertField: "subtitle",
        expected: "AX probe subtitle {ns}",
      },
    ],
  },
  {
    id: "coda-mcp-l2-subpage",
    title: "L2: create a subpage under a page",
    difficulty: "L2",
    prompt:
      'Create a new doc, add a parent page, then add a child page named "AX probe mcp subpage {ns}" under that parent. Report the child page id as gid and the parent doc id as docId.',
    allowed_surfaces: ["docs", "mcp"],
    na: false,
    create_path: "/docs/{docId}/pages",
    depends_on: [],
    trace: [],
    oracles: [
      {
        type: "roundtrip",
        description: "read the created child page back and assert its name",
        readPathTemplate: "/docs/{docId}/pages/{gid}",
        assertField: "name",
        expected: "AX probe mcp subpage {ns}",
      },
    ],
  },
  {
    id: "coda-mcp-l2-table-row",
    title: "L2: create a table with one row",
    difficulty: "L2",
    prompt:
      'Create a new doc, add a table whose identifying column is "Name", and create one row named "AX probe mcp row {ns}". Report the row id as gid, the parent doc id as docId, and the created table id as tableIdOrName.',
    allowed_surfaces: ["docs", "mcp"],
    na: false,
    create_path: "/docs/{docId}/tables/{tableIdOrName}/rows",
    depends_on: [],
    trace: [],
    oracles: [
      {
        type: "roundtrip",
        description: "read the created row back and assert its display name",
        readPathTemplate: "/docs/{docId}/tables/{tableIdOrName}/rows/{gid}",
        assertField: "name",
        expected: "AX probe mcp row {ns}",
      },
    ],
  },
  {
    id: "coda-mcp-l2-table-second-row",
    title: "L2: add a second row to a table",
    difficulty: "L2",
    prompt:
      'Create a new doc, add a table whose identifying column is "Name", seed it with one starter row, then add a second row named "AX probe mcp row-second {ns}". Report the second row id as gid, the parent doc id as docId, and the created table id as tableIdOrName.',
    allowed_surfaces: ["docs", "mcp"],
    na: false,
    create_path: "/docs/{docId}/tables/{tableIdOrName}/rows",
    depends_on: [],
    trace: [],
    oracles: [
      {
        type: "roundtrip",
        description: "read the added row back and assert its display name",
        readPathTemplate: "/docs/{docId}/tables/{tableIdOrName}/rows/{gid}",
        assertField: "name",
        expected: "AX probe mcp row-second {ns}",
      },
    ],
  },
  {
    id: "coda-mcp-l3-page-goal",
    title: "L3: ambiguous goal-level — page",
    difficulty: "L3",
    prompt:
      'A teammate says: "Please add \\"AX probe mcp page-goal {ns}\\" as a new page in a fresh planning doc for me." Infer the right objects to create, do it, and report the created page id as gid plus the parent doc id as docId.',
    allowed_surfaces: ["api", "docs", "mcp"],
    na: false,
    create_path: "/docs/{docId}/pages",
    depends_on: [],
    trace: [],
    oracles: [
      {
        type: "roundtrip",
        description: "read the created page back and assert its name",
        readPathTemplate: "/docs/{docId}/pages/{gid}",
        assertField: "name",
        expected: "AX probe mcp page-goal {ns}",
      },
    ],
  },
  {
    id: "coda-mcp-l4-page-rename",
    title: "L4: full lifecycle — create then rename a page",
    difficulty: "L4",
    prompt:
      'Create a new doc, add one page named "AX probe mcp page-pre {ns}", then rename that same page to "AX probe mcp page-renamed {ns}". Report the page id as gid and the parent doc id as docId.',
    allowed_surfaces: ["docs", "mcp"],
    na: false,
    create_path: "/docs/{docId}/pages",
    depends_on: [],
    trace: [],
    oracles: [
      {
        type: "roundtrip",
        description: "read the renamed page back and assert its name",
        readPathTemplate: "/docs/{docId}/pages/{gid}",
        assertField: "name",
        expected: "AX probe mcp page-renamed {ns}",
      },
    ],
  },
  {
    id: "coda-mcp-l4-row-rename",
    title: "L4: full lifecycle — create then rename a row",
    difficulty: "L4",
    prompt:
      'Create a new doc, add a table whose identifying column is "Name", create one row named "AX probe mcp row-pre {ns}", then update that same row so its display name is "AX probe mcp row-renamed {ns}". Report the row id as gid, the parent doc id as docId, and the created table id as tableIdOrName.',
    allowed_surfaces: ["docs", "mcp"],
    na: false,
    create_path: "/docs/{docId}/tables/{tableIdOrName}/rows",
    depends_on: [],
    trace: [],
    oracles: [
      {
        type: "roundtrip",
        description: "read the renamed row back and assert its display name",
        readPathTemplate: "/docs/{docId}/tables/{tableIdOrName}/rows/{gid}",
        assertField: "name",
        expected: "AX probe mcp row-renamed {ns}",
      },
    ],
  },
];

const CODA_PRESET: GeneratePreset<GenerateOptions> = {
  id: "coda",
  authoringHints: [
    "Coda is surface-asymmetric: preserve the curated MCP/page/row tasks instead of assuming MCP can mirror every REST resource.",
    "Keep CODA_API_KEY for REST/API auth and CODA_MCP_API_KEY for MCP auth. Do not collapse them into one env name in the generated pack.",
    "For API tasks, prefer docs, folders, packs, pages, and seeded real-table row flows over speculative table-creation behavior.",
    "For MCP tasks, keep page-centric and row-centric workflows with docId and tableIdOrName context in the reported ids.",
  ],
  options: {
    packName: "coda-generated",
    siteUrl: "https://coda.io/developers/apis/v1",
    openapiUrl: "https://coda.io/apis/v1/openapi.yaml",
    docsUrls: ["https://coda.io/developers/apis/v1"],
    authMethod: "pat",
    authScheme: "Bearer personal access token",
    authType: "bearer",
    authEnv: "CODA_API_KEY",
    sandboxScope: [],
    surfaces: {
      mcp: {
        server: "https://coda.io/apis/mcp",
        transport: "http",
        args: [],
        docs_url: "https://help.coda.io/hc/en-us/articles/44722661982989-Connect-to-the-Coda-MCP",
        auth: {
          kind: "token",
          token_env: "CODA_MCP_API_KEY",
          token_env_aliases: [],
          instructions:
            "Generate a Coda MCP-scoped personal access token and configure the MCP server with it.",
        },
      },
    },
    curatedTasks: CODA_CURATED_TASKS,
    surfaceTaskPolicies: {
      api: {
        simpleResources: ["docs", "folders", "packs"],
        nestedResources: ["docs", "pages"],
        goalResources: [],
        lifecycleResources: ["docs", "folders", "packs"],
      },
      mcp: {
        simpleResources: ["docs"],
        nestedResources: ["docs", "pages", "rows"],
        goalResources: [],
        lifecycleResources: [],
      },
    },
  },
};

const LINEAR_GRAPHQL_PRESET: GeneratePreset<GenerateGraphqlPackOptions> = {
  id: "linear",
  authoringHints: [
    "Linear's GraphQL surface is strong enough to support broad API/SDK coverage, but MCP lifecycle support is narrower. Keep MCP lifecycle tasks limited to issue/comment/document-style objects.",
    "Preserve @linear/sdk and the hosted MCP endpoint; this preset is about surface shaping, not renaming product metadata.",
  ],
  options: {
    packName: "linear-generated",
    baseUrl: "https://api.linear.app/graphql",
    siteUrl: "https://linear.app/developers",
    docsUrls: ["https://linear.app/developers/graphql"],
    authMethod: "api-key",
    authType: "api-key",
    authEnv: "LINEAR_API_KEY",
    authHeader: "Authorization",
    surfaces: {
      sdk: {
        package: "@linear/sdk",
        language: "node",
        reference_url: "https://linear.app/developers/sdk",
        auth: { kind: "inherit", token_env_aliases: [] },
      },
      mcp: {
        server: "https://mcp.linear.app/mcp",
        transport: "http",
        args: [],
        docs_url: "https://linear.app/docs/mcp",
        auth: {
          kind: "token",
          token_env: "LINEAR_API_KEY",
          token_env_aliases: [],
          instructions:
            "Linear's MCP server supports direct API keys in the Authorization header. The same LINEAR_API_KEY used for the GraphQL API works for MCP.",
        },
      },
    },
    surfaceTaskPolicies: {
      mcp: {
        lifecycleResources: ["issue", "comment", "document"],
      },
    },
  },
};

export function resolveOpenApiGeneratePreset(product: string): GeneratePreset<GenerateOptions> | undefined {
  switch (normalizeProduct(product)) {
    case "asana":
      return ASANA_PRESET;
    case "exa":
      return EXA_PRESET;
    case "coda":
      return CODA_PRESET;
    default:
      return undefined;
  }
}

export function resolveGraphqlGeneratePreset(product: string): GeneratePreset<GenerateGraphqlPackOptions> | undefined {
  switch (normalizeProduct(product)) {
    case "linear":
      return LINEAR_GRAPHQL_PRESET;
    default:
      return undefined;
  }
}
