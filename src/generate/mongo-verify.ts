import type { OracleSpec, TargetPack } from "../schemas.js";
import { safeDatabaseError } from "./database-error.js";

export interface MongoConnection {
  connectionString: string;
  database?: string;
}

export type MongoQuery = NonNullable<OracleSpec["mongoQuery"]>;

const FORBIDDEN_MONGO_OPERATORS = new Set(["$out", "$merge", "$function", "$accumulator", "$where"]);

function visitMongoValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) visitMongoValue(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_MONGO_OPERATORS.has(key)) {
      throw new Error(`MongoDB verifier query uses forbidden operator ${key}`);
    }
    visitMongoValue(child);
  }
}

export function assertReadOnlyMongoQuery(query: MongoQuery): void {
  visitMongoValue(query.filter);
  visitMongoValue(query.projection);
  visitMongoValue(query.sort);
  visitMongoValue(query.pipeline);
}

function applyTemplates(value: unknown, values: { ns?: string; gid?: string }): unknown {
  if (typeof value === "string") {
    return value.replace(/\{(ns|gid)\}/g, (_, name: "ns" | "gid") => {
      const replacement = values[name];
      if (!replacement) throw new Error(`MongoDB verifier query requires {${name}}`);
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map((item) => applyTemplates(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, applyTemplates(child, values)]),
    );
  }
  return value;
}

export function renderMongoQuery(query: MongoQuery, values: { ns?: string; gid?: string }): MongoQuery {
  const rendered = applyTemplates(query, values) as MongoQuery;
  const unresolved = JSON.stringify(rendered).match(/\{([A-Za-z_][A-Za-z0-9_]*)\}/)?.[1];
  if (unresolved) throw new Error(`unsupported MongoDB verifier template {${unresolved}}`);
  assertReadOnlyMongoQuery(rendered);
  return rendered;
}

export function resolveMongoConnection(pack: TargetPack): MongoConnection | null {
  if (!pack.mongo_conn) return null;
  const connectionString = process.env[pack.mongo_conn.connection_string_env]?.trim();
  if (!connectionString) {
    throw new Error(
      `mongo_conn declared (env ${pack.mongo_conn.connection_string_env}) but that env var is unset`,
    );
  }
  return { connectionString, database: pack.mongo_conn.database };
}

type MongoDocument = Record<string, unknown>;

function asDocument(value: unknown): MongoDocument {
  return value && typeof value === "object" && !Array.isArray(value) ? value as MongoDocument : {};
}

export async function runMongoCheck(connection: MongoConnection, query: MongoQuery): Promise<unknown> {
  try {
    assertReadOnlyMongoQuery(query);
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(connection.connectionString, { connectTimeoutMS: 10_000 });
    await client.connect();
    try {
      const db = client.db(query.database || connection.database);
      const collection = db.collection(query.collection);
      if (query.operation === "count") {
        return { count: await collection.countDocuments(asDocument(query.filter)) };
      }
      if (query.operation === "findOne") {
        return await collection.findOne(asDocument(query.filter), {
          projection: asDocument(query.projection),
          sort: asDocument(query.sort) as never,
        });
      }
      if (query.operation === "listCollections") {
        return await db.listCollections(asDocument(query.filter)).toArray();
      }
      return await collection.aggregate((query.pipeline ?? []) as MongoDocument[]).toArray();
    } finally {
      await client.close();
    }
  } catch (error) {
    throw safeDatabaseError(error, connection.connectionString);
  }
}
