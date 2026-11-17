import { pino } from "pino";
import { BullMqWorkerHost } from "../adapters/bullmq/bullmq-worker-host.js";
import { openDatabase } from "../adapters/drizzle/database.js";
import { DrizzleAssetRepository } from "../adapters/drizzle/drizzle-asset-repository.js";
import { DrizzleJobRepository } from "../adapters/drizzle/drizzle-job-repository.js";
import { NodeCommandRunner } from "../adapters/ffmpeg/command-runner.js";
import { FfmpegMediaTool } from "../adapters/ffmpeg/ffmpeg-media-tool.js";
import { openRedis } from "../adapters/redis/redis-connections.js";
import { RedisProgressBus } from "../adapters/redis/redis-progress-bus.js";
import { createS3Clients } from "../adapters/s3/s3-clients.js";
import { S3ObjectStore } from "../adapters/s3/s3-object-store.js";
import { SystemClock, TempDirWorkspaceProvider } from "../adapters/system/system-adapters.js";
import { RunJob } from "../app/run-job.js";
import type { WorkerConfig } from "../config/config.js";

/** A fully wired worker process: `start` begins consuming, `shutdown` drains and disconnects. */
export interface WorkerProcess {
  start(): void;
  shutdown(): Promise<void>;
}

/** The worker composition root: the only place that chooses concrete classes and connects them. */
export function composeWorker(config: WorkerConfig): WorkerProcess {
  const logger = pino({ level: config.logLevel });

  const { db, pool } = openDatabase({
    connectionString: config.database.url,
    ssl: config.database.ssl,
    poolSize: config.database.poolSize,
  });
  const redis = openRedis(config.queue.redisUrl, { blocking: true });
  // The worker only publishes; the subscriber connection stays idle and is never opened.
  const idleSubscriber = redis.duplicate({ lazyConnect: true });
  const { client, presignClient } = createS3Clients(config.s3);

  const runner = new RunJob({
    jobs: new DrizzleJobRepository(db),
    assets: new DrizzleAssetRepository(db),
    store: new S3ObjectStore({ bucket: config.s3.bucket, client, presignClient }),
    media: new FfmpegMediaTool(new NodeCommandRunner(), config.ffmpegPath, config.ffprobePath),
    bus: new RedisProgressBus(redis, idleSubscriber, logger),
    workspaces: new TempDirWorkspaceProvider(config.workDir),
    clock: new SystemClock(),
    logger,
    progressRecordIntervalMs: config.progressRecordIntervalMs,
  });
  const host = new BullMqWorkerHost({ connection: redis, runner, concurrency: config.concurrency, logger });

  return {
    start: () => {
      host.start();
      logger.info({ concurrency: config.concurrency }, "worker started");
    },
    shutdown: async () => {
      logger.info({ graceMs: config.shutdownGraceMs }, "worker draining");
      await host.stop(config.shutdownGraceMs);
      idleSubscriber.disconnect();
      await redis.quit();
      await pool.end();
      client.destroy();
      presignClient.destroy();
      logger.info({}, "worker stopped");
    },
  };
}
