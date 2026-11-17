import { openDatabase } from "./adapters/drizzle/database.js";
import { runMigrations } from "./adapters/drizzle/migrate.js";
import { loadMigrateConfig } from "./config/config.js";

const config = loadMigrateConfig(process.env);
const { db, pool } = openDatabase({
  connectionString: config.database.url,
  ssl: config.database.ssl,
  poolSize: 1,
});

try {
  await runMigrations(db, config.migrationsFolder);
  console.log("migrations applied");
} finally {
  await pool.end();
}
