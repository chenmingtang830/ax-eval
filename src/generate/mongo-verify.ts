import type { TargetPack } from "../schemas.js";
import type { EnvSource } from "../target/config.js";

export interface MongoConn {
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

export function resolveMongoConn(pack: TargetPack, env: EnvSource = process.env): MongoConn | null {
  if (!pack.mongo_conn) return null;
  const connectionString = env[pack.mongo_conn.connection_string_env]?.trim();
  if (!connectionString) {
    throw new Error(
      `mongo_conn declared (env ${pack.mongo_conn.connection_string_env}) but that env var is unset`,
    );
  }
  return { connectionString, database: pack.mongo_conn.database };
}

type MongoDocument = Record<string, unknown>;

function asRecord(value: unknown): MongoDocument {
  return value && typeof value === "object" && !Array.isArray(value) ? value as MongoDocument : {};
}

export async function runMongoCheck(conn: MongoConn, query: MongoQuery): Promise<unknown> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(conn.connectionString);
  await client.connect();
  try {
    const db = client.db(query.database || conn.database);
    const collection = db.collection(query.collection);
    if (query.operation === "count") {
      const count = await collection.countDocuments(asRecord(query.filter));
      return { count };
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
