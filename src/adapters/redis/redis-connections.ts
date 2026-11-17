import { Redis } from "ioredis";
import type { HealthCheck } from "../../ports/support.js";

/**
 * Opens a Redis connection. `blocking` connections (BullMQ workers) must retry forever;
 * request/response connections give up after a short while so the API can answer 503 instead of hanging.
 */
export function openRedis(url: string, options: { blocking: boolean }): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: options.blocking ? null : 2,
    connectionName: options.blocking ? "render-queue-worker" : "render-queue-api",
  });
}

/** Readiness probe that PINGs Redis. */
export class RedisHealthCheck implements HealthCheck {
  public readonly name = "redis";

  public constructor(private readonly redis: Redis) {}

  public async check(): Promise<void> {
    await this.redis.ping();
  }
}
