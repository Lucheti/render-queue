import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { JobQueue } from "../../ports/job-queue.js";
import { RENDER_JOB_NAME, RENDER_QUEUE, type RenderJobPayload, type RetryPolicy } from "./queue-contract.js";

const ONE_DAY_SECONDS = 24 * 60 * 60;

/** JobQueue backed by a BullMQ queue. The BullMQ job id is the render job id, so a repeat enqueue is a no-op. */
export class BullMqJobQueue implements JobQueue {
  private readonly queue: Queue<RenderJobPayload>;

  public constructor(
    connection: Redis,
    private readonly retry: RetryPolicy,
  ) {
    this.queue = new Queue<RenderJobPayload>(RENDER_QUEUE, { connection });
  }

  public async enqueue(jobId: string): Promise<void> {
    await this.queue.add(
      RENDER_JOB_NAME,
      { jobId },
      {
        jobId,
        attempts: this.retry.attempts,
        backoff: { type: "exponential", delay: this.retry.backoffMs },
        removeOnComplete: { age: ONE_DAY_SECONDS, count: 1000 },
        removeOnFail: { age: 7 * ONE_DAY_SECONDS },
      },
    );
  }

  /** Releases the queue's Redis resources. */
  public async close(): Promise<void> {
    await this.queue.close();
  }
}
