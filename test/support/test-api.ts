import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { CompleteUpload } from "../../src/app/complete-upload.js";
import { CreateJob } from "../../src/app/create-job.js";
import { CreateUpload } from "../../src/app/create-upload.js";
import { GetJob } from "../../src/app/get-job.js";
import { WatchJob } from "../../src/app/watch-job.js";
import { ByteSize } from "../../src/domain/byte-size.js";
import { ApiKeyAuthenticator } from "../../src/http/auth.js";
import { ReadinessProbe } from "../../src/http/readiness.js";
import { buildServer } from "../../src/http/server.js";
import type { HealthCheck } from "../../src/ports/support.js";
import {
  FixedClock,
  InMemoryAssetRepository,
  InMemoryJobRepository,
  InMemoryObjectStore,
  InMemoryProgressBus,
  RecordingQueue,
  SequentialIds,
} from "./fakes.js";

export const API_KEY = "test-api-key-0123456789";
export const AUTH = { "x-api-key": API_KEY } as const;

export interface TestApi {
  readonly app: FastifyInstance;
  readonly assets: InMemoryAssetRepository;
  readonly jobs: InMemoryJobRepository;
  readonly store: InMemoryObjectStore;
  readonly queue: RecordingQueue;
  readonly bus: InMemoryProgressBus;
  readonly checks: { postgres: boolean; redis: boolean; s3: boolean };
}

/** The real HTTP layer and use cases over in-memory ports. */
export async function buildTestApi(options: { rateLimitMax?: number; heartbeatMs?: number } = {}): Promise<TestApi> {
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const store = new InMemoryObjectStore();
  const queue = new RecordingQueue();
  const bus = new InMemoryProgressBus();
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const logger = pino({ level: "silent" });
  const maxSize = ByteSize.of(1_000_000);

  const checks = { postgres: true, redis: true, s3: true };
  const probe = (name: keyof typeof checks): HealthCheck => ({
    name,
    check: async () => {
      if (!checks[name]) {
        throw new Error(`${name} down`);
      }
    },
  });

  const getJob = new GetJob(jobs, assets, store, clock, 3_600);
  const app = await buildServer({
    logger,
    authenticator: new ApiKeyAuthenticator(API_KEY),
    readiness: new ReadinessProbe([probe("postgres"), probe("redis"), probe("s3")], 200),
    rateLimit: { max: options.rateLimitMax ?? 1_000, windowSeconds: 60 },
    corsOrigins: [],
    sseHeartbeatMs: options.heartbeatMs ?? 15_000,
    createUpload: new CreateUpload(assets, store, ids, clock, { maxSize, urlTtlSeconds: 900 }),
    completeUpload: new CompleteUpload(assets, store, clock, maxSize),
    createJob: new CreateJob(assets, jobs, queue, ids, clock, logger),
    getJob,
    watchJob: new WatchJob(jobs, bus),
  });
  return { app, assets, jobs, store, queue, bus, checks };
}
