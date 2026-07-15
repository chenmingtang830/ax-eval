import { describe, expect, it } from "vitest";
import { assertReadOnlyMongoQuery, renderMongoQuery } from "../src/generate/mongo-verify.js";

describe("MongoDB verification safety", () => {
  it("renders declarative read templates", () => {
    const query = renderMongoQuery({
      database: "sandbox",
      collection: "widgets_{ns}",
      operation: "findOne",
      filter: { _id: "{gid}" },
    }, { ns: "run-ab12", gid: "widget-1" });
    expect(query.collection).toBe("widgets_run-ab12");
    expect(query.filter).toEqual({ _id: "widget-1" });
  });

  it("rejects write stages and server-side code", () => {
    expect(() => assertReadOnlyMongoQuery({
      database: "sandbox",
      collection: "widgets",
      operation: "aggregate",
      pipeline: [{ $out: "copied_widgets" }],
    })).toThrow(/\$out/);
    expect(() => assertReadOnlyMongoQuery({
      database: "sandbox",
      collection: "widgets",
      operation: "findOne",
      filter: { $where: "true" },
    })).toThrow(/\$where/);
    expect(() => renderMongoQuery({
      database: "sandbox",
      collection: "{collection}",
      operation: "count",
    }, {})).toThrow(/unsupported/);
  });
});
