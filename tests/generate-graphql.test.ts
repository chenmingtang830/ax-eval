import { describe, expect, it } from "vitest";
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

    const l3 = pack.tasks.find((t) => t.id === "gen-gql-l3-issue")!;
    expect(l3.prompt).toMatch(/to-do list/);
    expect(l3.prompt).not.toMatch(/mutation\s+issueCreate/);

    const l4 = pack.tasks.find((t) => t.id === "gen-gql-l4-issue-lifecycle")!;
    expect(l4.prompt).toMatch(/update that same issue/);
    expect(l4.oracles[0]!.expected).toBe("AX probe issue-renamed {ns}");
  });
});
