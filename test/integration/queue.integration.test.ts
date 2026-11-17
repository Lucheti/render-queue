import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BullMqJobQueue } from "../../src/adapters/bullmq/bullmq-job-queue.js";
import { BullMqWorkerHost } from "../../src/adapters/bullmq/bullmq-worker-host.js";
import { RENDER_QUEUE } from "../../src/adapters/bullmq/queue-contract.js";
import { openRedis } from "../../src/adapters/redis/redis-connections.js";
import { RedisProgressBus } from "../../src/adapters/redis/redis-progress-bus.js";
import type { JobRunner, RunJobInput } from "../../src/app/run-job.js";
import type { JobEvent } from "../../src/domain/job-event.js";
import { JobAbortedError, PermanentJobError, TransientJobError } from "../../src/domain/job-failure.js";
import { silentLogger } from "../support/fakes.js";
import { eventually, integrationEnv } from "./support.js";

describe("RedisProgressBus", () => {
  let publisher: Redis;
  let bus: RedisProgressBus;
  let otherProcess: RedisProgressBus;
  const connections: Redis[] = [];

  beforeAll(() => {
    publisher = openRedis(integrationEnv.REDIS_URL, { blocking: false });
    const subscriber = publisher.duplicate();
    const remotePublisher = openRedis(integrationEnv.REDIS_URL, { blocking: false });
    const remoteSubscriber = remotePublisher.duplicate();
    connections.push(publisher, subscriber, remotePublisher, remoteSubscriber);
    bus = new RedisProgressBus(publisher, subscriber, silentLogger);
    otherProcess = new RedisProgressBus(remotePublisher, remoteSubscriber, silentLogger);
  });

  afterAll(() => {
    for (const connection of connections) {
      connection.disconnect();
    }
  });

  it("delivers events published by another process to every subscriber of that job only", async () => {
    const jobId = randomUUID();
    const first: JobEvent[] = [];
    const second: JobEvent[] = [];
    const unrelated: JobEvent[] = [];
    await bus.subscribe(jobId, (event) => first.push(event));
    await bus.subscribe(jobId, (event) => second.push(event));
    await bus.subscribe(randomUUID(), (event) => unrelated.push(event));

    await otherProcess.publish({ type: "progress", jobId, percent: 40 });
    await otherProcess.publish({ type: "failed", jobId, error: { code: "invalid_media", message: "bad" } });

    const expected: JobEvent[] = [
      { type: "progress", jobId, percent: 40 },
      { type: "failed", jobId, error: { code: "invalid_media", message: "bad" } },
    ];
    await eventually(() => first.length === 2 && second.length === 2);
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(unrelated).toEqual([]);
  });

  it("stops delivering once the last listener unsubscribes", async () => {
    const jobId = randomUUID();
    const received: JobEvent[] = [];
    const subscription = await bus.subscribe(jobId, (event) => received.push(event));
    await otherProcess.publish({ type: "completed", jobId });
    await eventually(() => received.length === 1);

    await subscription.close();
    await otherProcess.publish({ type: "completed", jobId });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(received).toHaveLength(1);
  });
});

describe("BullMqJobQueue and BullMqWorkerHost", () => {
  let connection: Redis;
  let workerConnection: Redis;
  let inspector: Queue;
  let producer: BullMqJobQueue;
  let host: BullMqWorkerHost | null = null;

  beforeAll(() => {
    connection = openRedis(integrationEnv.REDIS_URL, { blocking: false });
    workerConnection = openRedis(integrationEnv.REDIS_URL, { blocking: true });
    inspector = new Queue(RENDER_QUEUE, { connection });
  });

  beforeEach(async () => {
    await inspector.obliterate({ force: true });
    producer = new BullMqJobQueue(connection, { attempts: 3, backoffMs: 20 });
  });

  afterEach(async () => {
    await host?.stop(1_000);
    host = null;
    await producer.close();
  });

  afterAll(async () => {
    await inspector.close();
    connection.disconnect();
    workerConnection.disconnect();
  });

  function startHost(runner: JobRunner): void {
    host = new BullMqWorkerHost({ connection: workerConnection, runner, concurrency: 2, logger: silentLogger });
    host.start();
  }

  it("runs an enqueued job once and passes the final-attempt flag", async () => {
    const calls: RunJobInput[] = [];
    startHost({ execute: async (input) => void calls.push(input) });
    const jobId = randomUUID();

    await producer.enqueue(jobId);
    await producer.enqueue(jobId);

    await eventually(async () => (await inspector.getJob(jobId))?.finishedOn !== undefined);
    expect(calls).toEqual([{ jobId, isFinalAttempt: false }]);
  });

  it("retries a transient failure with backoff until it succeeds, flagging the last attempt", async () => {
    const calls: RunJobInput[] = [];
    startHost({
      execute: async (input) => {
        calls.push(input);
        if (calls.length < 3) {
          throw new TransientJobError("ffmpeg_failed", "boom");
        }
      },
    });
    const jobId = randomUUID();

    await producer.enqueue(jobId);

    await eventually(async () => (await inspector.getJob(jobId))?.finishedOn !== undefined);
    expect(calls.map((call) => call.isFinalAttempt)).toEqual([false, false, true]);
    expect(await (await inspector.getJob(jobId))?.getState()).toBe("completed");
  });

  it("gives up after the configured attempts", async () => {
    let calls = 0;
    startHost({
      execute: async () => {
        calls += 1;
        throw new TransientJobError("ffmpeg_failed", "boom");
      },
    });
    const jobId = randomUUID();

    await producer.enqueue(jobId);

    await eventually(async () => (await (await inspector.getJob(jobId))?.getState()) === "failed");
    expect(calls).toBe(3);
  });

  it("does not retry a permanent failure", async () => {
    let calls = 0;
    startHost({
      execute: async () => {
        calls += 1;
        throw new PermanentJobError("invalid_media", "unreadable");
      },
    });
    const jobId = randomUUID();

    await producer.enqueue(jobId);

    await eventually(async () => (await (await inspector.getJob(jobId))?.getState()) === "failed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toBe(1);
  });

  it("hands a running job back to the queue, without spending an attempt, when shutdown aborts it", async () => {
    let started = false;
    startHost({
      execute: (_input, signal) =>
        new Promise<void>((_resolve, reject) => {
          started = true;
          signal.addEventListener("abort", () => reject(new JobAbortedError()), { once: true });
        }),
    });
    const jobId = randomUUID();
    await producer.enqueue(jobId);
    await eventually(() => started);

    await host?.stop(50);
    host = null;

    const job = await inspector.getJob(jobId);
    expect(await job?.getState()).toBe("waiting");
    expect(job?.attemptsMade).toBe(0);
  });
});
