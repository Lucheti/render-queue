import { UnrecoverableError, WaitingError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { JobRunner } from "../../app/run-job.js";
import { JobAbortedError, PermanentJobError } from "../../domain/job-failure.js";
import type { Logger } from "../../ports/support.js";
import { RENDER_QUEUE, type RenderJobPayload } from "./queue-contract.js";

export interface WorkerHostOptions {
  readonly connection: Redis;
  readonly runner: JobRunner;
  readonly concurrency: number;
  readonly logger: Logger;
}

/** Consumes the render queue and translates the use case's outcomes into BullMQ's retry vocabulary. */
export class BullMqWorkerHost {
  private worker: Worker<RenderJobPayload> | null = null;

  public constructor(private readonly options: WorkerHostOptions) {}

  /** Starts pulling jobs. */
  public start(): void {
    const { connection, concurrency, logger } = this.options;
    const worker = new Worker<RenderJobPayload>(RENDER_QUEUE, this.process, { connection, concurrency });
    worker.on("error", (error) => logger.error({ error }, "worker error"));
    worker.on("failed", (job, error) =>
      logger.warn({ jobId: job?.id, attemptsMade: job?.attemptsMade, error: error.message }, "queue job failed"),
    );
    this.worker = worker;
  }

  /**
   * Stops taking new jobs and waits for running ones. After `graceMs` the running jobs are aborted and handed
   * back to the queue, which is what ECS expects before it sends SIGKILL.
   */
  public async stop(graceMs: number): Promise<void> {
    const worker = this.worker;
    if (worker === null) {
      return;
    }
    const closing = worker.close();
    const timer = setTimeout(() => worker.cancelAllJobs("worker shutting down"), graceMs);
    try {
      await closing;
    } finally {
      clearTimeout(timer);
      this.worker = null;
    }
  }

  // The third parameter is what makes BullMQ hand the processor an AbortSignal.
  private readonly process = async (job: Job<RenderJobPayload>, token?: string, signal?: AbortSignal): Promise<void> => {
    const maxAttempts = job.opts.attempts ?? 1;
    try {
      await this.options.runner.execute(
        { jobId: job.data.jobId, isFinalAttempt: job.attemptsMade + 1 >= maxAttempts },
        signal ?? new AbortController().signal,
      );
    } catch (error) {
      if (error instanceof PermanentJobError) {
        throw new UnrecoverableError(error.message);
      }
      if (error instanceof JobAbortedError) {
        await job.moveToWait(token);
        throw new WaitingError();
      }
      throw error;
    }
  };
}
