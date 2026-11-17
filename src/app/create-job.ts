import { ConflictError, NotFoundError, UnavailableError } from "../domain/errors.js";
import { Job } from "../domain/job.js";
import type { JobSpec } from "../domain/job-spec.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { AssetRepository, JobRepository } from "../ports/repositories.js";
import type { Clock, IdGenerator, Logger } from "../ports/support.js";

export interface CreateJobCommand {
  readonly assetId: string;
  readonly spec: JobSpec;
}

/** Records a job for an uploaded asset and puts it on the queue. */
export class CreateJob {
  public constructor(
    private readonly assets: AssetRepository,
    private readonly jobs: JobRepository,
    private readonly queue: JobQueue,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** Returns the new job id. The row is written before the queue entry so a worker never sees an unknown id. */
  public async execute(command: CreateJobCommand): Promise<string> {
    const asset = await this.assets.findById(command.assetId);
    if (asset === null) {
      throw new NotFoundError("asset_not_found", `Asset ${command.assetId} does not exist.`);
    }
    if (!asset.isUploaded()) {
      throw new ConflictError("asset_not_uploaded", `Asset ${command.assetId} has not finished uploading.`);
    }

    const job = Job.enqueue({ id: this.ids.next(), assetId: command.assetId, spec: command.spec, now: this.clock.now() });
    await this.jobs.insert(job);

    try {
      await this.queue.enqueue(job.id);
    } catch (cause) {
      await this.jobs.delete(job.id).catch((error: unknown) => {
        this.logger.error({ jobId: job.id, error }, "failed to roll back job after enqueue failure");
      });
      throw new UnavailableError("queue_unavailable", "The job queue is unavailable, try again shortly.", { cause });
    }
    return job.id;
  }
}
