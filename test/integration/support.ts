import { setTimeout as sleep } from "node:timers/promises";
import type { Database } from "../../src/adapters/drizzle/database.js";
import { runMigrations } from "../../src/adapters/drizzle/migrate.js";
import type pg from "pg";

/** Connection settings for the services the integration suite needs; the defaults match docker-compose. */
export const integrationEnv = {
  DATABASE_URL: process.env["DATABASE_URL"] ?? "postgres://render:render@localhost:5432/render",
  REDIS_URL: process.env["REDIS_URL"] ?? "redis://localhost:6379/15",
  S3_BUCKET: process.env["S3_BUCKET"] ?? "render-queue-it",
  S3_ENDPOINT: process.env["S3_ENDPOINT"] ?? "http://localhost:9000",
  S3_REGION: process.env["S3_REGION"] ?? "us-east-1",
  S3_FORCE_PATH_STYLE: "true",
  AWS_ACCESS_KEY_ID: process.env["AWS_ACCESS_KEY_ID"] ?? "minioadmin",
  AWS_SECRET_ACCESS_KEY: process.env["AWS_SECRET_ACCESS_KEY"] ?? "minioadmin",
} as const;

process.env["AWS_ACCESS_KEY_ID"] = integrationEnv.AWS_ACCESS_KEY_ID;
process.env["AWS_SECRET_ACCESS_KEY"] = integrationEnv.AWS_SECRET_ACCESS_KEY;

/** Drops everything and re-applies the committed migrations, so each file starts from a known schema. */
export async function resetDatabase(db: Database, pool: pg.Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(db, "drizzle");
}

/** Polls until `check` returns a value or the deadline passes. */
export async function eventually<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await sleep(50);
  }
}
