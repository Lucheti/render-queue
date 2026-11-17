import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { BullMqJobQueue } from "../adapters/bullmq/bullmq-job-queue.js";
import { openDatabase } from "../adapters/drizzle/database.js";
import { DrizzleAssetRepository } from "../adapters/drizzle/drizzle-asset-repository.js";
import { DrizzleJobRepository } from "../adapters/drizzle/drizzle-job-repository.js";
import { PostgresHealthCheck } from "../adapters/drizzle/postgres-health-check.js";
import { openRedis, RedisHealthCheck } from "../adapters/redis/redis-connections.js";
import { RedisProgressBus } from "../adapters/redis/redis-progress-bus.js";
import { createS3Clients } from "../adapters/s3/s3-clients.js";
import { S3HealthCheck, S3ObjectStore } from "../adapters/s3/s3-object-store.js";
import { SystemClock, UuidGenerator } from "../adapters/system/system-adapters.js";
import { CompleteUpload } from "../app/complete-upload.js";
import { CreateJob } from "../app/create-job.js";
import { CreateUpload } from "../app/create-upload.js";
import { GetJob } from "../app/get-job.js";
import { WatchJob } from "../app/watch-job.js";
import { ByteSize } from "../domain/byte-size.js";
import type { ApiConfig } from "../config/config.js";
import { ApiKeyAuthenticator } from "../http/auth.js";
import { ReadinessProbe } from "../http/readiness.js";
import { buildServer } from "../http/server.js";

const READINESS_TIMEOUT_MS = 2_000;

/** A fully wired API process: start it with `server.listen`, stop it with `shutdown`. */
export interface ApiProcess {
  readonly server: FastifyInstance;
  shutdown(): Promise<void>;
}

/** The API composition root: the only place that chooses concrete classes and connects them. */
export async function composeApi(config: ApiConfig): Promise<ApiProcess> {
  const logger = pino({ level: config.logLevel });

  const { db, pool } = openDatabase({
    connectionString: config.database.url,
    ssl: config.database.ssl,
    poolSize: config.database.poolSize,
  });
  const redis = openRedis(config.queue.redisUrl, { blocking: false });
  const subscriber = redis.duplicate();
  const rateLimitRedis = redis.duplicate({ connectTimeout: 500, maxRetriesPerRequest: 1 });
  const { client, presignClient } = createS3Clients(config.s3);

  const clock = new SystemClock();
  const ids = new UuidGenerator();
  const assets = new DrizzleAssetRepository(db);
  const jobs = new DrizzleJobRepository(db);
  const store = new S3ObjectStore({ bucket: config.s3.bucket, client, presignClient });
  const queue = new BullMqJobQueue(redis, { attempts: config.queue.attempts, backoffMs: config.queue.backoffMs });
  const bus = new RedisProgressBus(redis, subscriber, logger);

  const maxSize = ByteSize.of(config.maxUploadBytes);
  const getJob = new GetJob(jobs, assets, store, clock, config.downloadUrlTtlSeconds);

  const server = await buildServer({
    logger,
    authenticator: new ApiKeyAuthenticator(config.apiKey),
    readiness: new ReadinessProbe(
      [new PostgresHealthCheck(pool), new RedisHealthCheck(redis), new S3HealthCheck(client, config.s3.bucket)],
      READINESS_TIMEOUT_MS,
    ),
    rateLimit: { max: config.rateLimit.max, windowSeconds: config.rateLimit.windowSeconds, redis: rateLimitRedis },
    corsOrigins: config.corsOrigins,
    sseHeartbeatMs: config.sseHeartbeatMs,
    createUpload: new CreateUpload(assets, store, ids, clock, { maxSize, urlTtlSeconds: config.uploadUrlTtlSeconds }),
    completeUpload: new CompleteUpload(assets, store, clock, maxSize),
    createJob: new CreateJob(assets, jobs, queue, ids, clock, logger),
    getJob,
    watchJob: new WatchJob(jobs, bus),
  });

  return {
    server,
    shutdown: async () => {
      await server.close();
      await queue.close();
      rateLimitRedis.disconnect();
      subscriber.disconnect();
      await redis.quit();
      await pool.end();
      client.destroy();
      presignClient.destroy();
    },
  };
}
