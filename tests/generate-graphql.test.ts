import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestGraphqlDetailed } from "../src/ingest/graphql.js";
import { generateGraphqlPack } from "../src/generate/graphql-pack.js";
import { TargetPackSchema } from "../src/schemas.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "graphql-introspection.json",
);

describe("GraphQL rich ingest", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("parses mutation return types, query fields, and object fields", async () => {
    const schema = await ingestGraphqlDetailed(FIXTURE);

    expect(schema.format).toBe("introspection");
    expect(schema.createMutations).toEqual(["issueCreate", "commentCreate"]);
    expect(schema.mutationDetails).toContainEqual({
      name: "issueCreate",
      returnTypeName: "IssuePayload",
      args: ["input"],
      argDetails: [{ name: "input", typeName: "IssueCreateInput" }],
    });
    expect(schema.queryTypeFields).toContainEqual({
      name: "issue",
      typeName: "Issue",
      args: ["id"],
      argDetails: [{ name: "id", typeName: "ID" }],
    });
    expect(schema.inputTypeDetails.find((t) => t.name === "CommentCreateInput")?.fields).toContainEqual({
      name: "issueId",
      typeName: "ID",
    });
    expect(schema.typeDetails.find((t) => t.name === "Issue")?.fields).toContainEqual({
      name: "title",
      typeName: "String",
      args: [],
      argDetails: [],
    });
  });

  it("falls back to batched type introspection when the one-shot query is too complex", async () => {
    const responses = [
      {
        ok: false,
        status: 400,
        body: {
          errors: [
            {
              message: "Query too complex",
              extensions: { code: "INPUT_ERROR" },
            },
          ],
        },
      },
      {
        ok: true,
        status: 200,
        body: {
          data: {
            __schema: {
              queryType: { name: "Query" },
              mutationType: { name: "Mutation" },
              types: [
                { kind: "OBJECT", name: "Query" },
                { kind: "OBJECT", name: "Mutation" },
                { kind: "OBJECT", name: "IssuePayload" },
                { kind: "OBJECT", name: "Issue" },
                { kind: "INPUT_OBJECT", name: "IssueCreateInput" },
              ],
            },
          },
        },
      },
      {
        ok: true,
        status: 200,
        body: {
          data: {
            t0: {
              kind: "OBJECT",
              name: "Query",
              fields: [
                {
                  name: "issue",
                  type: { kind: "OBJECT", name: "Issue" },
                  args: [
                    {
                      name: "id",
                      type: { kind: "SCALAR", name: "ID" },
                    },
                  ],
                },
              ],
              inputFields: null,
            },
            t1: {
              kind: "OBJECT",
              name: "Mutation",
              fields: [
                {
                  name: "issueCreate",
                  type: { kind: "OBJECT", name: "IssuePayload" },
                  args: [
                    {
                      name: "input",
                      type: { kind: "INPUT_OBJECT", name: "IssueCreateInput" },
                    },
                  ],
                },
              ],
              inputFields: null,
            },
            t2: {
              kind: "OBJECT",
              name: "IssuePayload",
              fields: [
                {
                  name: "issue",
                  type: { kind: "OBJECT", name: "Issue" },
                  args: [],
                },
              ],
              inputFields: null,
            },
            t3: {
              kind: "OBJECT",
              name: "Issue",
              fields: [
                {
                  name: "title",
                  type: { kind: "SCALAR", name: "String" },
                  args: [],
                },
              ],
              inputFields: null,
            },
            t4: {
              kind: "INPUT_OBJECT",
              name: "IssueCreateInput",
              fields: null,
              inputFields: [
                {
                  name: "title",
                  type: { kind: "SCALAR", name: "String" },
                },
              ],
            },
          },
        },
      },
    ];

    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch");
      return {
        ok: next.ok,
        status: next.status,
        text: async () => JSON.stringify(next.body),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const schema = await ingestGraphqlDetailed("https://api.linear.app/graphql");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(schema.createMutations).toEqual(["issueCreate"]);
    expect(schema.queryTypeFields).toContainEqual({
      name: "issue",
      typeName: "Issue",
      args: ["id"],
      argDetails: [{ name: "id", typeName: "ID" }],
    });
    expect(schema.typeDetails.find((t) => t.name === "Issue")?.fields).toContainEqual({
      name: "title",
      typeName: "String",
      args: [],
      argDetails: [],
    });
  });
});

describe("GraphQL pack generation", () => {
  it("generates a valid GraphQL pack with deterministic read-back oracles", async () => {
    const schema = await ingestGraphqlDetailed(FIXTURE);
    const pack = generateGraphqlPack(schema, {
      packName: "linear-generated",
      product: "Linear",
      baseUrl: "https://api.linear.app/graphql",
      siteUrl: "https://linear.app/developers",
      docsUrls: ["https://linear.app/developers/graphql"],
      runId: "2026-06-08-gql",
    });

    expect(() => TargetPackSchema.parse(pack)).not.toThrow();
    expect(pack.api_style).toBe("graphql");
    expect(pack.base_url).toBe("https://api.linear.app/graphql");
    expect(pack.generated_by).toBe("deterministic@graphql-pack");
    expect(pack.discovery?.canonical_endpoint).toBe("mutation issueCreate");
    expect(pack.tasks.map((t) => t.difficulty)).toEqual(["L1", "L2", "L3", "L4"]);

    const l1 = pack.tasks.find((t) => t.id === "gen-gql-l1-issue")!;
    expect(l1.difficulty).toBe("L1");
    expect(l1.prompt).toContain("AX probe issue {ns}");

    const oracle = l1.oracles[0]!;
    expect(oracle.type).toBe("roundtrip");
    expect(oracle.readQueryTemplate).toBe('{ issue(id: "{gid}") { title } }');
    expect(oracle.readPathTemplate).toBeUndefined();
    expect(oracle.assertField).toBe("issue.title");
    expect(oracle.expected).toBe("AX probe issue {ns}");

    const l2 = pack.tasks.find((t) => t.id === "gen-gql-l2-issue-comment")!;
    expect(l2.prompt).toMatch(/using its id/);
    expect(l2.depends_on).toEqual(["issue"]);
    expect(l2.oracles[0]!.readQueryTemplate).toBe('{ comment(id: "{gid}") { text } }');
    expect(l2.oracles[0]!.assertField).toBe("comment.text");

    const l3 = pack.tasks.find((t) => t.id === "gen-gql-l3-issue-1")!;
    expect(l3.prompt).toMatch(/to-do list/);
    expect(l3.prompt).not.toMatch(/mutation\s+issueCreate/);

    const l4 = pack.tasks.find((t) => t.id === "gen-gql-l4-issue-lifecycle")!;
    expect(l4.prompt).toMatch(/update that same issue/);
    expect(l4.oracles[0]!.expected).toBe("AX probe issue-renamed {ns}");
  });

  it("can emit multiple L3 tasks and backfill a full pack toward harder tiers", async () => {
    const schema = await ingestGraphqlDetailed(FIXTURE);
    schema.createMutations = [...schema.createMutations, "noteCreate"];
    schema.mutations = [...schema.mutations, { name: "noteCreate", isCreate: true }];
    schema.mutationDetails = [
      ...schema.mutationDetails,
      {
        name: "noteCreate",
        returnTypeName: "NotePayload",
        args: ["input"],
        argDetails: [{ name: "input", typeName: "NoteCreateInput" }],
      },
      {
        name: "noteUpdate",
        returnTypeName: "NotePayload",
        args: ["input"],
        argDetails: [{ name: "input", typeName: "NoteUpdateInput" }],
      },
    ];
    schema.queryTypeFields = [
      ...schema.queryTypeFields,
      {
        name: "note",
        typeName: "Note",
        args: ["id"],
        argDetails: [{ name: "id", typeName: "ID" }],
      },
    ];
    schema.typeDetails = [
      ...schema.typeDetails,
      {
        name: "NotePayload",
        fields: [{ name: "note", typeName: "Note", args: [], argDetails: [] }],
      },
      {
        name: "Note",
        fields: [{ name: "name", typeName: "String", args: [], argDetails: [] }],
      },
    ];
    schema.inputTypeDetails = [
      ...schema.inputTypeDetails,
      {
        name: "NoteCreateInput",
        fields: [{ name: "name", typeName: "String" }],
      },
      {
        name: "NoteUpdateInput",
        fields: [
          { name: "id", typeName: "ID" },
          { name: "name", typeName: "String" },
        ],
      },
    ];
    const pack = generateGraphqlPack(schema, {
      packName: "linear-generated",
      product: "Linear",
      baseUrl: "https://api.linear.app/graphql",
      limit: 1,
      l2Limit: 1,
      l3Limit: 2,
      l4Limit: 2,
      targetTaskCount: 6,
    });

    expect(pack.tasks).toHaveLength(6);
    expect(pack.tasks.filter((t) => t.difficulty === "L3")).toHaveLength(2);
    expect(pack.tasks.filter((t) => t.difficulty === "L4")).toHaveLength(2);
  });

  it("skips create-style mutations that do not have a derivable read-back query", async () => {
    const schema = await ingestGraphqlDetailed(FIXTURE);
    schema.createMutations = ["createOrganizationFromOnboarding", ...schema.createMutations];
    schema.mutations = [
      { name: "createOrganizationFromOnboarding", isCreate: true },
      ...schema.mutations,
    ];
    schema.mutationDetails = [
      {
        name: "createOrganizationFromOnboarding",
        returnTypeName: "AuthOrganizationPayload",
        args: ["input"],
        argDetails: [{ name: "input", typeName: "AuthOrganizationInput" }],
      },
      ...schema.mutationDetails,
    ];
    schema.typeDetails = [
      {
        name: "AuthOrganizationPayload",
        fields: [{ name: "organization", typeName: "AuthOrganization", args: [], argDetails: [] }],
      },
      {
        name: "AuthOrganization",
        fields: [{ name: "name", typeName: "String", args: [], argDetails: [] }],
      },
      ...schema.typeDetails,
    ];
    schema.inputTypeDetails = [
      {
        name: "AuthOrganizationInput",
        fields: [{ name: "name", typeName: "String" }],
      },
      ...schema.inputTypeDetails,
    ];

    const pack = generateGraphqlPack(schema, {
      packName: "linear-generated",
      product: "Linear",
      baseUrl: "https://api.linear.app/graphql",
    });

    expect(pack.tasks.some((t) => /organization/i.test(t.id))).toBe(false);
    expect(pack.tasks.some((t) => t.id === "gen-gql-l1-issue")).toBe(true);
  });

  it("prefers issue-like resources over generic customer resources when ranking tasks", async () => {
    const schema = await ingestGraphqlDetailed(FIXTURE);
    schema.createMutations = ["customerCreate", ...schema.createMutations];
    schema.mutations = [
      { name: "customerCreate", isCreate: true },
      ...schema.mutations,
    ];
    schema.mutationDetails = [
      {
        name: "customerCreate",
        returnTypeName: "CustomerPayload",
        args: ["input"],
        argDetails: [{ name: "input", typeName: "CustomerCreateInput" }],
      },
      ...schema.mutationDetails,
    ];
    schema.queryTypeFields = [
      {
        name: "customer",
        typeName: "Customer",
        args: ["id"],
        argDetails: [{ name: "id", typeName: "ID" }],
      },
      ...schema.queryTypeFields,
    ];
    schema.typeDetails = [
      {
        name: "CustomerPayload",
        fields: [{ name: "customer", typeName: "Customer", args: [], argDetails: [] }],
      },
      {
        name: "Customer",
        fields: [{ name: "name", typeName: "String", args: [], argDetails: [] }],
      },
      ...schema.typeDetails,
    ];
    schema.inputTypeDetails = [
      {
        name: "CustomerCreateInput",
        fields: [{ name: "name", typeName: "String" }],
      },
      ...schema.inputTypeDetails,
    ];

    const pack = generateGraphqlPack(schema, {
      packName: "linear-generated",
      product: "Linear",
      baseUrl: "https://api.linear.app/graphql",
    });

    expect(pack.discovery?.canonical_endpoint).toBe("mutation issueCreate");
    expect(pack.tasks.find((t) => t.difficulty === "L1")?.id).toBe("gen-gql-l1-issue");
  });

  it("dedupes same-label resources and prefers non-batch mutations for canonical discovery", async () => {
    const schema = await ingestGraphqlDetailed(FIXTURE);
    schema.createMutations = ["issueBatchCreate", ...schema.createMutations];
    schema.mutations = [{ name: "issueBatchCreate", isCreate: true }, ...schema.mutations];
    schema.mutationDetails = [
      {
        name: "issueBatchCreate",
        returnTypeName: "IssuePayload",
        args: ["input"],
        argDetails: [{ name: "input", typeName: "IssueCreateInput" }],
      },
      ...schema.mutationDetails,
    ];

    const pack = generateGraphqlPack(schema, {
      packName: "linear-generated",
      product: "Linear",
      baseUrl: "https://api.linear.app/graphql",
      limit: 5,
    });

    expect(pack.discovery?.canonical_endpoint).toBe("mutation issueCreate");
    expect(pack.tasks.filter((t) => t.id === "gen-gql-l1-issue")).toHaveLength(1);
  });

  it("filters risky admin and premium-leaning resources out of generated tasks", async () => {
    const schema = await ingestGraphqlDetailed(FIXTURE);
    schema.createMutations = [...schema.createMutations, "releaseCreate", "oauthApplicationCreate", "integrationCreate"];
    schema.mutations = [
      ...schema.mutations,
      { name: "releaseCreate", isCreate: true },
      { name: "oauthApplicationCreate", isCreate: true },
      { name: "integrationCreate", isCreate: true },
    ];
    schema.mutationDetails = [
      ...schema.mutationDetails,
      { name: "releaseCreate", returnTypeName: "ReleasePayload", args: ["input"], argDetails: [{ name: "input", typeName: "ReleaseCreateInput" }] },
      { name: "releaseUpdate", returnTypeName: "ReleasePayload", args: ["input"], argDetails: [{ name: "input", typeName: "ReleaseUpdateInput" }] },
      { name: "oauthApplicationCreate", returnTypeName: "OauthApplicationPayload", args: ["input"], argDetails: [{ name: "input", typeName: "OauthApplicationCreateInput" }] },
      { name: "oauthApplicationUpdate", returnTypeName: "OauthApplicationPayload", args: ["input"], argDetails: [{ name: "input", typeName: "OauthApplicationUpdateInput" }] },
      { name: "integrationCreate", returnTypeName: "IntegrationPayload", args: ["input"], argDetails: [{ name: "input", typeName: "IntegrationCreateInput" }] },
      { name: "integrationUpdate", returnTypeName: "IntegrationPayload", args: ["input"], argDetails: [{ name: "input", typeName: "IntegrationUpdateInput" }] },
    ];
    schema.queryTypeFields = [
      ...schema.queryTypeFields,
      { name: "release", typeName: "Release", args: ["id"], argDetails: [{ name: "id", typeName: "ID" }] },
      { name: "oauthApplication", typeName: "OauthApplication", args: ["id"], argDetails: [{ name: "id", typeName: "ID" }] },
      { name: "integration", typeName: "Integration", args: ["id"], argDetails: [{ name: "id", typeName: "ID" }] },
    ];
    schema.typeDetails = [
      ...schema.typeDetails,
      { name: "ReleasePayload", fields: [{ name: "release", typeName: "Release", args: [], argDetails: [] }] },
      { name: "Release", fields: [{ name: "name", typeName: "String", args: [], argDetails: [] }] },
      { name: "OauthApplicationPayload", fields: [{ name: "oauthApplication", typeName: "OauthApplication", args: [], argDetails: [] }] },
      { name: "OauthApplication", fields: [{ name: "name", typeName: "String", args: [], argDetails: [] }] },
      { name: "IntegrationPayload", fields: [{ name: "integration", typeName: "Integration", args: [], argDetails: [] }] },
      { name: "Integration", fields: [{ name: "id", typeName: "ID", args: [], argDetails: [] }] },
    ];
    schema.inputTypeDetails = [
      ...schema.inputTypeDetails,
      { name: "ReleaseCreateInput", fields: [{ name: "name", typeName: "String" }] },
      { name: "ReleaseUpdateInput", fields: [{ name: "id", typeName: "ID" }, { name: "name", typeName: "String" }] },
      { name: "OauthApplicationCreateInput", fields: [{ name: "name", typeName: "String" }] },
      { name: "OauthApplicationUpdateInput", fields: [{ name: "id", typeName: "ID" }, { name: "name", typeName: "String" }] },
      { name: "IntegrationCreateInput", fields: [{ name: "name", typeName: "String" }] },
      { name: "IntegrationUpdateInput", fields: [{ name: "id", typeName: "ID" }] },
    ];

    const pack = generateGraphqlPack(schema, {
      packName: "linear-generated",
      product: "Linear",
      baseUrl: "https://api.linear.app/graphql",
      limit: 10,
      l3Limit: 3,
      l4Limit: 10,
    });

    expect(pack.tasks.some((t) => /release|oauth|integration/i.test(t.id))).toBe(false);
  });

  it("skips lifecycle tasks when the only mutable identity is the resource id", async () => {
    const schema = await ingestGraphqlDetailed(FIXTURE);
    schema.createMutations = [...schema.createMutations, "widgetCreate"];
    schema.mutations = [...schema.mutations, { name: "widgetCreate", isCreate: true }];
    schema.mutationDetails = [
      ...schema.mutationDetails,
      { name: "widgetCreate", returnTypeName: "WidgetPayload", args: ["input"], argDetails: [{ name: "input", typeName: "WidgetCreateInput" }] },
      { name: "widgetUpdate", returnTypeName: "WidgetPayload", args: ["input"], argDetails: [{ name: "input", typeName: "WidgetUpdateInput" }] },
    ];
    schema.queryTypeFields = [
      ...schema.queryTypeFields,
      { name: "widget", typeName: "Widget", args: ["id"], argDetails: [{ name: "id", typeName: "ID" }] },
    ];
    schema.typeDetails = [
      ...schema.typeDetails,
      { name: "WidgetPayload", fields: [{ name: "widget", typeName: "Widget", args: [], argDetails: [] }] },
      { name: "Widget", fields: [{ name: "id", typeName: "ID", args: [], argDetails: [] }] },
    ];
    schema.inputTypeDetails = [
      ...schema.inputTypeDetails,
      { name: "WidgetCreateInput", fields: [{ name: "name", typeName: "String" }] },
      { name: "WidgetUpdateInput", fields: [{ name: "id", typeName: "ID" }] },
    ];

    const pack = generateGraphqlPack(schema, {
      packName: "linear-generated",
      product: "Linear",
      baseUrl: "https://api.linear.app/graphql",
      limit: 10,
      l4Limit: 10,
    });

    expect(pack.tasks.some((t) => t.id === "gen-gql-l4-widget-lifecycle")).toBe(false);
  });

  it("uses body-like fields for comment resources instead of asserting opaque ids", async () => {
    const schema = await ingestGraphqlDetailed(FIXTURE);
    schema.typeDetails = schema.typeDetails.map((type) =>
      type.name === "Comment"
        ? {
            ...type,
            fields: [
              { name: "id", typeName: "ID", args: [], argDetails: [] },
              { name: "body", typeName: "String", args: [], argDetails: [] },
            ],
          }
        : type,
    );
    schema.inputTypeDetails = schema.inputTypeDetails.map((type) =>
      type.name === "CommentCreateInput"
        ? {
            ...type,
            fields: [
              { name: "issueId", typeName: "ID" },
              { name: "body", typeName: "String" },
            ],
          }
        : type,
    );

    const pack = generateGraphqlPack(schema, {
      packName: "linear-generated",
      product: "Linear",
      baseUrl: "https://api.linear.app/graphql",
      limit: 2,
      l2Limit: 1,
      l3Limit: 1,
      l4Limit: 1,
    });

    const commentTask = pack.tasks.find((task) => task.id === "gen-gql-l2-issue-comment")!;
    expect(commentTask.prompt).toContain('comment with body "AX probe comment {ns}"');
    expect(commentTask.oracles[0]!.readQueryTemplate).toBe('{ comment(id: "{gid}") { body } }');
    expect(commentTask.oracles[0]!.assertField).toBe("comment.body");
    expect(commentTask.oracles[0]!.expected).toBe("AX probe comment {ns}");
  });

  it("passes through declared non-api surfaces onto the generated GraphQL pack", async () => {
    const schema = await ingestGraphqlDetailed(FIXTURE);

    const pack = generateGraphqlPack(schema, {
      packName: "linear-generated",
      product: "Linear",
      baseUrl: "https://api.linear.app/graphql",
      surfaces: {
        cli: { bin: "linear", docs_url: "https://example.test/cli" },
        sdk: { package: "@linear/sdk", language: "node" },
        mcp: { server: "https://mcp.linear.app/mcp", transport: "http" },
      },
    });

    expect(pack.surfaces).toEqual({
      cli: { bin: "linear", docs_url: "https://example.test/cli" },
      sdk: { package: "@linear/sdk", language: "node" },
      mcp: { server: "https://mcp.linear.app/mcp", transport: "http" },
    });
    expect(pack.tasks.every((task) => task.allowed_surfaces.includes("docs"))).toBe(true);
    expect(pack.tasks.every((task) => task.allowed_surfaces.includes("api"))).toBe(true);
    expect(pack.tasks.every((task) => task.allowed_surfaces.includes("cli"))).toBe(true);
    expect(pack.tasks.every((task) => task.allowed_surfaces.includes("sdk"))).toBe(true);
    expect(pack.tasks.some((task) => task.allowed_surfaces.includes("mcp"))).toBe(true);
  });

  it("skips cycle lifecycle targets that are too namespace-sensitive to rename reliably", async () => {
    const schema = await ingestGraphqlDetailed(FIXTURE);

    const pack = generateGraphqlPack(schema, {
      packName: "linear-generated",
      product: "Linear",
      baseUrl: "https://api.linear.app/graphql",
      limit: 10,
      l4Limit: 20,
    });

    expect(pack.tasks.some((task) => task.id === "gen-gql-l4-cycle-lifecycle")).toBe(false);
  });

  it("drops MCP from Linear lifecycle tasks whose tool coverage is incomplete", async () => {
    const schema = await ingestGraphqlDetailed(FIXTURE);
    schema.createMutations = [
      ...schema.createMutations,
      "initiativeCreate",
      "projectLabelCreate",
      "issueLabelCreate",
      "cycleCreate",
    ];
    schema.mutations = [
      ...schema.mutations,
      { name: "initiativeCreate", isCreate: true },
      { name: "projectLabelCreate", isCreate: true },
      { name: "issueLabelCreate", isCreate: true },
      { name: "cycleCreate", isCreate: true },
    ];
    schema.mutationDetails = [
      ...schema.mutationDetails,
      { name: "initiativeCreate", returnTypeName: "InitiativePayload", args: ["input"], argDetails: [{ name: "input", typeName: "InitiativeCreateInput" }] },
      { name: "initiativeUpdate", returnTypeName: "InitiativePayload", args: ["input"], argDetails: [{ name: "input", typeName: "InitiativeUpdateInput" }] },
      { name: "projectLabelCreate", returnTypeName: "ProjectLabelPayload", args: ["input"], argDetails: [{ name: "input", typeName: "ProjectLabelCreateInput" }] },
      { name: "projectLabelUpdate", returnTypeName: "ProjectLabelPayload", args: ["input"], argDetails: [{ name: "input", typeName: "ProjectLabelUpdateInput" }] },
      { name: "issueLabelCreate", returnTypeName: "IssueLabelPayload", args: ["input"], argDetails: [{ name: "input", typeName: "IssueLabelCreateInput" }] },
      { name: "issueLabelUpdate", returnTypeName: "IssueLabelPayload", args: ["input"], argDetails: [{ name: "input", typeName: "IssueLabelUpdateInput" }] },
      { name: "cycleCreate", returnTypeName: "CyclePayload", args: ["input"], argDetails: [{ name: "input", typeName: "CycleCreateInput" }] },
      { name: "cycleUpdate", returnTypeName: "CyclePayload", args: ["input"], argDetails: [{ name: "input", typeName: "CycleUpdateInput" }] },
    ];
    schema.queryTypeFields = [
      ...schema.queryTypeFields,
      { name: "initiative", typeName: "Initiative", args: ["id"], argDetails: [{ name: "id", typeName: "ID" }] },
      { name: "projectLabel", typeName: "ProjectLabel", args: ["id"], argDetails: [{ name: "id", typeName: "ID" }] },
      { name: "issueLabel", typeName: "IssueLabel", args: ["id"], argDetails: [{ name: "id", typeName: "ID" }] },
      { name: "cycle", typeName: "Cycle", args: ["id"], argDetails: [{ name: "id", typeName: "ID" }] },
    ];
    schema.typeDetails = [
      ...schema.typeDetails,
      { name: "InitiativePayload", fields: [{ name: "initiative", typeName: "Initiative", args: [], argDetails: [] }] },
      { name: "Initiative", fields: [{ name: "name", typeName: "String", args: [], argDetails: [] }] },
      { name: "ProjectLabelPayload", fields: [{ name: "projectLabel", typeName: "ProjectLabel", args: [], argDetails: [] }] },
      { name: "ProjectLabel", fields: [{ name: "name", typeName: "String", args: [], argDetails: [] }] },
      { name: "IssueLabelPayload", fields: [{ name: "issueLabel", typeName: "IssueLabel", args: [], argDetails: [] }] },
      { name: "IssueLabel", fields: [{ name: "name", typeName: "String", args: [], argDetails: [] }] },
      { name: "CyclePayload", fields: [{ name: "cycle", typeName: "Cycle", args: [], argDetails: [] }] },
      { name: "Cycle", fields: [{ name: "name", typeName: "String", args: [], argDetails: [] }] },
    ];
    schema.inputTypeDetails = [
      ...schema.inputTypeDetails,
      { name: "InitiativeCreateInput", fields: [{ name: "name", typeName: "String" }] },
      { name: "InitiativeUpdateInput", fields: [{ name: "id", typeName: "ID" }, { name: "name", typeName: "String" }] },
      { name: "ProjectLabelCreateInput", fields: [{ name: "name", typeName: "String" }] },
      { name: "ProjectLabelUpdateInput", fields: [{ name: "id", typeName: "ID" }, { name: "name", typeName: "String" }] },
      { name: "IssueLabelCreateInput", fields: [{ name: "name", typeName: "String" }] },
      { name: "IssueLabelUpdateInput", fields: [{ name: "id", typeName: "ID" }, { name: "name", typeName: "String" }] },
      { name: "CycleCreateInput", fields: [{ name: "name", typeName: "String" }] },
      { name: "CycleUpdateInput", fields: [{ name: "id", typeName: "ID" }, { name: "name", typeName: "String" }] },
    ];

    const pack = generateGraphqlPack(schema, {
      packName: "linear-generated",
      product: "Linear",
      baseUrl: "https://api.linear.app/graphql",
      limit: 10,
      l4Limit: 20,
      surfaces: {
        sdk: { package: "@linear/sdk", language: "node" },
        mcp: { server: "https://mcp.linear.app/mcp", transport: "http" },
      },
    });

    const supportedLifecycles = pack.tasks.filter((task) =>
      /^gen-gql-l4-(issue|comment|document)-lifecycle$/.test(task.id),
    );
    const unsupportedLifecycles = pack.tasks.filter((task) =>
      /^gen-gql-l4-(project-label|initiative|issue-label)-lifecycle$/.test(task.id),
    );

    expect(supportedLifecycles.length).toBeGreaterThan(0);
    expect(unsupportedLifecycles.length).toBeGreaterThan(0);

    for (const task of supportedLifecycles) {
      expect(task.allowed_surfaces).toContain("mcp");
    }
    for (const task of unsupportedLifecycles) {
      expect(task.allowed_surfaces).toEqual(["docs", "api", "sdk"]);
    }
  });
});
