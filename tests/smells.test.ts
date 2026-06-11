import { describe, expect, it } from "vitest";
import { auditSpecQuality, renderSpecQuality, renderSpecQualityHtml, type SmellCategory } from "../src/static/smells.js";

/** Categories detected on the first endpoint of a single-operation spec. */
function categories(spec: object): Set<SmellCategory> {
  const a = auditSpecQuality(JSON.stringify(spec));
  return new Set(a.endpoints[0]?.smells.map((s) => s.category) ?? []);
}

/** A fully agent-ready POST operation — no smells should fire on it. */
function cleanOperation() {
  return {
    summary: "Create a customer order",
    description:
      "Creates a new order for the authenticated account and returns the persisted order with its server-assigned id.",
    security: [{ bearer: [] }],
    requestBody: {
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["sku"],
            properties: {
              sku: { type: "string", description: "Stock-keeping unit of the product to order (e.g. SKU-123)." },
              quantity: { type: "integer", description: "Number of units to order; defaults to 1 when omitted." },
            },
          },
        },
      },
    },
    responses: {
      "201": {
        description: "The order was created and is returned with its id and current status.",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Server-assigned order id." },
                status: { type: "string", description: "Order lifecycle status." },
              },
            },
          },
        },
      },
      "400": { description: "The request body failed validation." },
    },
  };
}

const SECURE_COMPONENTS = {
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", description: "Send a bearer token obtained from /oauth/token." },
    },
  },
};

function specWith(path: string, method: string, op: object, extra: object = {}) {
  return { openapi: "3.0.0", info: { title: "T" }, ...SECURE_COMPONENTS, paths: { [path]: { [method]: op } }, ...extra };
}

describe("content-quality smell audit", () => {
  it("a fully-documented operation has no smells and scores 100", () => {
    const a = auditSpecQuality(JSON.stringify(specWith("/orders", "post", cleanOperation())));
    expect(a.endpointsAnalyzed).toBe(1);
    expect(a.totalSmells).toBe(0);
    expect(a.score).toBe(100);
  });

  it("LAZY: missing summary/description", () => {
    const op = { ...cleanOperation(), summary: "", description: "" };
    expect(categories(specWith("/orders", "post", op))).toContain("LAZY");
  });

  it("INPUT: undocumented body field", () => {
    const op = cleanOperation();
    // strip descriptions off the body properties
    op.requestBody.content["application/json"].schema.properties = {
      sku: { type: "string" },
      quantity: { type: "integer" },
    } as never;
    const cats = categories(specWith("/orders", "post", op));
    expect(cats).toContain("INPUT");
  });

  it("RESPONSE: no responses, generic description, and generic data envelope all fire", () => {
    const none = { ...cleanOperation(), responses: {} };
    expect(categories(specWith("/orders", "post", none))).toContain("RESPONSE");

    const generic = {
      ...cleanOperation(),
      responses: {
        "200": {
          description: "Successful Response",
          content: { "application/json": { schema: { type: "object", properties: { data: { type: "object" } } } } },
        },
      },
    };
    expect(categories(specWith("/orders", "post", generic))).toContain("RESPONSE");
  });

  it("PATH: action verb in the URI", () => {
    expect(categories(specWith("/createNewOrder", "post", cleanOperation()))).toContain("PATH");
    expect(categories(specWith("/orders/get", "get", cleanOperation()))).toContain("PATH");
  });

  it("METHOD: GET with a request body, and GET for a create", () => {
    const getWithBody = { ...cleanOperation(), operationId: "listOrders" };
    expect(categories(specWith("/orders", "get", getWithBody))).toContain("METHOD");

    const getCreate = { ...cleanOperation(), requestBody: undefined, operationId: "createOrder" };
    expect(categories(specWith("/orders", "get", getCreate))).toContain("METHOD");
  });

  it("SECURITY: defines schemes but the operation requires none", () => {
    const op = { ...cleanOperation(), security: undefined };
    expect(categories(specWith("/orders", "post", op))).toContain("SECURITY");
  });

  it("SECURITY: a referenced scheme without operational guidance", () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "T" },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } }, // no description
      paths: { "/orders": { post: cleanOperation() } },
    };
    expect(categories(spec)).toContain("SECURITY");
  });

  it("FRAGMENTED: a broken local $ref", () => {
    const op = {
      ...cleanOperation(),
      requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Missing" } } } },
    };
    expect(categories(specWith("/orders", "post", op))).toContain("FRAGMENTED");
  });

  it("a clean public spec (no security schemes declared) does not raise SECURITY", () => {
    const op = { ...cleanOperation(), security: undefined };
    const spec = { openapi: "3.0.0", info: { title: "Public" }, paths: { "/orders": { post: op } } };
    expect(categories(spec)).not.toContain("SECURITY");
  });

  it("aggregates prevalence by category and renders markdown", () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Mixed" },
      ...SECURE_COMPONENTS,
      paths: {
        "/orders": { post: cleanOperation() },
        "/createThing": { post: { ...cleanOperation(), summary: "", description: "" } },
      },
    };
    const a = auditSpecQuality(JSON.stringify(spec), "mixed-spec");
    expect(a.endpointsAnalyzed).toBe(2);
    expect(a.byCategory.PATH).toBe(1); // only /createThing
    expect(a.byCategory.LAZY).toBe(1);
    expect(a.score).toBeGreaterThan(0);
    expect(a.score).toBeLessThan(100);

    const md = renderSpecQuality(a);
    expect(md).toContain("Content-quality audit");
    expect(md).toContain("Smell prevalence");
    expect(md).toContain("| smell | group | weight | endpoints | % |");
    expect(md).toContain("REST design style");
    expect(md).toContain("POST /createThing");
  });

  it("renders smell groups so owners can filter intentional style conventions", () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Grouped" },
      ...SECURE_COMPONENTS,
      paths: {
        "/createThing": { post: { ...cleanOperation(), summary: "", description: "" } },
      },
    };
    const a = auditSpecQuality(JSON.stringify(spec), "grouped-spec");
    const html = renderSpecQualityHtml(a, { generatedAt: "2026-06-11T00:00:00.000Z" });

    expect(html).toContain("Documentation clarity");
    expect(html).toContain("REST design style");
    expect(html).toContain("intentional product convention");
    expect(html).toContain("design-style exception");
  });

  it("empty spec scores 0 with no endpoints", () => {
    const a = auditSpecQuality(JSON.stringify({ openapi: "3.0.0", info: {}, paths: {} }));
    expect(a.endpointsAnalyzed).toBe(0);
    expect(a.score).toBe(0);
  });
});
