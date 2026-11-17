import type pg from "pg";
import type { HealthCheck } from "../../ports/support.js";

/** Readiness probe that runs `SELECT 1` against the pool. */
export class PostgresHealthCheck implements HealthCheck {
  public readonly name = "postgres";

  public constructor(private readonly pool: pg.Pool) {}

  public async check(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}
