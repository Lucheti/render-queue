import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./database.js";

/** Applies the committed SQL migrations in `migrationsFolder`. */
export async function runMigrations(db: Database, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}
