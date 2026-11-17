import { assertNever } from "../domain/assert-never.js";
import { NotFoundError } from "../domain/errors.js";
import type { JobEvent } from "../domain/job-event.js";
import type { JobSnapshot } from "../domain/job.js";
import type { ProgressBus, Subscription } from "../ports/progress-bus.js";
import type { JobRepository } from "../ports/repositories.js";

/** Streams a job's events to a listener, starting from its current state. */
export class WatchJob {
  public constructor(
    private readonly jobs: JobRepository,
    private readonly bus: ProgressBus,
  ) {}

  /**
   * Subscribes first and reads the job second, so an event published in between is delivered
   * rather than lost. The first event the listener receives always reflects the stored state.
   */
  public async execute(jobId: string, listener: (event: JobEvent) => void): Promise<Subscription> {
    const subscription = await this.bus.subscribe(jobId, listener);
    try {
      const job = await this.jobs.findById(jobId);
      if (job === null) {
        throw new NotFoundError("job_not_found", `Job ${jobId} does not exist.`);
      }
      listener(WatchJob.currentEvent(job.snapshot()));
    } catch (error) {
      await subscription.close();
      throw error;
    }
    return subscription;
  }

  private static currentEvent(job: JobSnapshot): JobEvent {
    switch (job.status) {
      case "queued":
      case "running":
        return { type: "progress", jobId: job.id, percent: job.progress };
      case "completed":
        return { type: "completed", jobId: job.id };
      case "failed":
        return {
          type: "failed",
          jobId: job.id,
          error: job.error ?? { code: "unknown", message: "The job failed." },
        };
      default:
        return assertNever(job.status);
    }
  }
}
