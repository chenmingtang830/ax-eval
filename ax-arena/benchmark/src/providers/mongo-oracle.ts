import type {
  OracleProvider,
  OracleResult,
  OracleSpec,
  OracleVerifyContext,
} from "ax-eval";
import {
  applyOracleTemplates,
  errorMessageFromResult,
  expectedDetail,
  expectedValues,
  resolveDotted,
  valuesMatch,
} from "./oracle-utils.js";

export interface MongoConnection {
  connectionString: string;
  database?: string;
}

export interface MongoQuery {
  database: string;
  collection: string;
  operation: "count" | "findOne" | "aggregate" | "listCollections";
  filter?: unknown;
  projection?: unknown;
  sort?: unknown;
  pipeline?: unknown[];
}

export type MongoQueryRunner = (connection: MongoConnection, query: MongoQuery) => Promise<unknown>;

type MongoDocument = Record<string, unknown>;

function asRecord(value: unknown): MongoDocument {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as MongoDocument
    : {};
}

export async function runMongoQuery(connection: MongoConnection, query: MongoQuery): Promise<unknown> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(connection.connectionString);
  await client.connect();
  try {
    const db = client.db(query.database || connection.database);
    const collection = db.collection(query.collection);
    if (query.operation === "count") {
      return { count: await collection.countDocuments(asRecord(query.filter)) };
    }
    if (query.operation === "findOne") {
      return await collection.findOne(asRecord(query.filter), {
        projection: asRecord(query.projection),
        sort: asRecord(query.sort) as never,
      });
    }
    if (query.operation === "listCollections") {
      return await db.listCollections(asRecord(query.filter)).toArray();
    }
    return await collection.aggregate((query.pipeline ?? []) as MongoDocument[]).toArray();
  } finally {
    await client.close();
  }
}

function connectionFor(ctx: OracleVerifyContext): MongoConnection | undefined {
  if (!ctx.pack.mongo_conn) return undefined;
  const envName = ctx.pack.mongo_conn.connection_string_env;
  const connectionString = ctx.credentials[envName]?.trim();
  if (!connectionString) {
    throw new Error(`mongo_conn declared (credential ${envName}) but that credential is unset`);
  }
  return { connectionString, database: ctx.pack.mongo_conn.database };
}

async function verifyMongo(
  oracle: OracleSpec,
  ctx: OracleVerifyContext,
  run: MongoQueryRunner,
): Promise<OracleResult> {
  const connection = connectionFor(ctx);
  if (!connection) {
    return { type: "roundtrip", passed: false, detail: "oracle has mongoQuery but pack declares no mongo_conn" };
  }
  if (!oracle.assertField) {
    return { type: "roundtrip", passed: false, detail: "oracle missing assertField" };
  }
  const query = applyOracleTemplates(oracle.mongoQuery, ctx) as MongoQuery;
  const result = await run(connection, query);
  const actual = resolveDotted(result, oracle.assertField);
  const expected = expectedValues(oracle, ctx.ns);
  return {
    type: "roundtrip",
    passed: valuesMatch(actual, expected, oracle.matchMode),
    detail: [
      `${oracle.assertField}=${JSON.stringify(actual)} expected=${expectedDetail(expected)}`,
      actual === undefined ? errorMessageFromResult(result) : undefined,
    ].filter(Boolean).join("; "),
  };
}

export function createMongoOracleProvider(run: MongoQueryRunner = runMongoQuery): OracleProvider {
  return {
    id: "arena-mongo",
    version: "1.0.0",
    matches: (oracle) => oracle.mongoQuery !== undefined,
    verify: (oracle, ctx) => verifyMongo(oracle, ctx, run),
  };
}
