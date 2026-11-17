import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
}

/** Opens a pooled Postgres connection and wraps it in Drizzle. The caller owns `pool.end()`. */
export function openDatabase(options: { connectionString: string; ssl: boolean; poolSize: number }): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
    max: options.poolSize,
  });
  return { db: drizzle(pool, { schema }), pool };
}
