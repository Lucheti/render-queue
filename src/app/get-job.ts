import { NotFoundError } from "../domain/errors.js";
import type { JobError } from "../domain/job.js";
import type { JobKind } from "../domain/job-spec.js";
import type { JobStatus } from "../domain/job-status.js";
import type { ObjectStore } from "../ports/object-store.js";
import type { AssetRepository, JobRepository } from "../ports/repositories.js";
import type { Clock } from "../ports/support.js";

export interface ResultView {
  readonly assetId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly downloadUrl: string;
  readonly expiresAt: Date;
}

export interface JobView {
  readonly id: string;
  readonly assetId: string;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly progress: number;
  readonly attempts: number;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly result: ResultView | null;
  readonly error: JobError | null;
}

/** Reads a job and, once it has finished, signs a download URL for its output. */
export class GetJob {
  public constructor(
    private readonly jobs: JobRepository,
    private readonly assets: AssetRepository,
    private readonly store: ObjectStore,
    private readonly clock: Clock,
    private readonly downloadTtlSeconds: number,
  ) {}

  /** Throws NotFoundError for an unknown id. */
  public async execute(jobId: string): Promise<JobView> {
    const job = await this.jobs.findById(jobId);
    if (job === null) {
      throw new NotFoundError("job_not_found", `Job ${jobId} does not exist.`);
    }
    const state = job.snapshot();
    return {
      id: state.id,
      assetId: state.assetId,
      kind: state.spec.kind,
      status: state.status,
      progress: state.progress,
      attempts: state.attempts,
      createdAt: state.createdAt,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      result: state.resultAssetId === null ? null : await this.describeResult(state.resultAssetId),
      error: state.error,
    };
  }

  private async describeResult(assetId: string): Promise<ResultView | null> {
    const asset = await this.assets.findById(assetId);
    if (asset === null) {
      return null;
    }
    const output = asset.snapshot();
    const downloadUrl = await this.store.presignDownload({
      key: output.storageKey,
      filename: output.filename,
      expiresInSeconds: this.downloadTtlSeconds,
    });
    return {
      assetId: output.id,
      filename: output.filename,
      contentType: output.contentType,
      sizeBytes: output.sizeBytes,
      downloadUrl,
      expiresAt: new Date(this.clock.now().getTime() + this.downloadTtlSeconds * 1000),
    };
  }
}
