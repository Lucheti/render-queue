import { Asset } from "../domain/asset.js";
import { ByteSize } from "../domain/byte-size.js";
import { ContentType } from "../domain/content-type.js";
import { Filename } from "../domain/filename.js";
import { JobAbortedError, PermanentJobError, TransientJobError } from "../domain/job-failure.js";
import type { Job, JobError } from "../domain/job.js";
import { assertFitsMedia, describeOutput, type JobSpec } from "../domain/job-spec.js";
import type { MediaTool } from "../ports/media-tool.js";
import type { ObjectStore } from "../ports/object-store.js";
import type { ProgressBus } from "../ports/progress-bus.js";
import type { AssetRepository, JobRepository } from "../ports/repositories.js";
import type { Clock, Logger, Workspace, WorkspaceProvider } from "../ports/support.js";
import { ProgressReporter } from "./progress-reporter.js";

export interface RunJobInput {
  readonly jobId: string;
  /** True when the queue will not retry this job after the current attempt fails. */
  readonly isFinalAttempt: boolean;
}

/** What the worker host calls for each queue message. */
export interface JobRunner {
  /**
   * Resolves when the job completed (or was already finished).
   * Throws PermanentJobError (do not retry), TransientJobError (retry) or JobAbortedError (shutdown, re-queue).
   */
  execute(input: RunJobInput, signal: AbortSignal): Promise<void>;
}

export interface RunJobDependencies {
  readonly jobs: JobRepository;
  readonly assets: AssetRepository;
  readonly store: ObjectStore;
  readonly media: MediaTool;
  readonly bus: ProgressBus;
  readonly workspaces: WorkspaceProvider;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Minimum gap between progress writes to the database. */
  readonly progressRecordIntervalMs: number;
}

const PROGRESS_CEILING = 99;
const MAX_BASENAME = 200;

/** Executes one render job end to end and keeps its stored status and event stream truthful. */
export class RunJob implements JobRunner {
  public constructor(private readonly deps: RunJobDependencies) {}

  public async execute(input: RunJobInput, signal: AbortSignal): Promise<void> {
    const { jobs, clock, logger } = this.deps;

    const stored = await jobs.findById(input.jobId);
    if (stored === null) {
      throw new PermanentJobError("job_not_found", `Job ${input.jobId} does not exist.`);
    }
    if (stored.isTerminal()) {
      logger.info({ jobId: input.jobId }, "job already finished, skipping duplicate delivery");
      return;
    }

    let job = stored.startAttempt(clock.now());
    await jobs.save(job);
    logger.info({ jobId: job.id, kind: job.spec.kind, attempt: job.snapshot().attempts }, "job started");

    const reporter = new ProgressReporter(
      {
        record: async (percent) => {
          job = job.reportProgress(percent);
          await jobs.save(job);
        },
        publish: (percent) => this.deps.bus.publish({ type: "progress", jobId: input.jobId, percent }),
      },
      clock,
      this.deps.progressRecordIntervalMs,
      logger,
    );

    const workspace = await this.deps.workspaces.create();
    try {
      const resultAssetId = await this.render(job, workspace, reporter, signal);
      await reporter.drain();
      job = job.complete(resultAssetId, clock.now());
      await jobs.save(job);
      await this.deps.bus.publish({ type: "completed", jobId: job.id });
      logger.info({ jobId: job.id }, "job completed");
    } catch (error) {
      await reporter.drain();
      throw await this.settleFailure(job, error, input.isFinalAttempt, signal);
    } finally {
      await workspace.dispose();
    }
  }

  private async render(job: Job, workspace: Workspace, reporter: ProgressReporter, signal: AbortSignal): Promise<string> {
    const { assets, store, media } = this.deps;

    const source = await assets.findById(job.assetId);
    if (source === null || !source.isUploaded()) {
      throw new PermanentJobError("source_unavailable", `Source asset ${job.assetId} is missing or not uploaded.`);
    }

    const inputPath = workspace.pathFor("input");
    await store.download(source.storageKey, inputPath, signal);

    const { durationSeconds } = await media.probe(inputPath, signal);
    assertFitsMedia(job.spec, durationSeconds);

    const output = describeOutput(job.spec);
    const outputPath = workspace.pathFor(`output.${output.extension}`);
    await media.execute(
      { spec: job.spec, inputPath, outputPath, inputDurationSeconds: durationSeconds },
      (percent) => reporter.report(Math.min(percent, PROGRESS_CEILING)),
      signal,
    );

    const storageKey = `renders/${job.id}/output.${output.extension}`;
    const uploaded = await store.upload({ key: storageKey, sourcePath: outputPath, contentType: output.contentType, signal });

    // The result asset reuses the job id, so a retry after a crash finds it instead of duplicating it.
    if ((await assets.findById(job.id)) === null) {
      await assets.insert(
        Asset.rendered({
          id: job.id,
          storageKey,
          filename: Filename.of(RunJob.outputName(source.snapshot().filename, job.spec, output.extension)),
          contentType: ContentType.of(output.contentType),
          size: ByteSize.of(uploaded.sizeBytes),
          now: this.deps.clock.now(),
        }),
      );
    }
    return job.id;
  }

  private async settleFailure(job: Job, error: unknown, isFinalAttempt: boolean, signal: AbortSignal): Promise<Error> {
    const { logger } = this.deps;

    if (error instanceof JobAbortedError || signal.aborted) {
      logger.warn({ jobId: job.id }, "job interrupted by shutdown, leaving it to be re-queued");
      return new JobAbortedError();
    }
    if (error instanceof PermanentJobError) {
      logger.warn({ jobId: job.id, code: error.code, message: error.message }, "job failed permanently");
      await this.recordFailure(job, { code: error.code, message: error.message });
      return error;
    }

    const failure =
      error instanceof TransientJobError
        ? error
        : new TransientJobError("render_failed", "The render failed unexpectedly.", { cause: error });
    logger.warn({ jobId: job.id, code: failure.code, error, isFinalAttempt }, "job attempt failed");
    if (isFinalAttempt) {
      await this.recordFailure(job, { code: failure.code, message: `${failure.message} Retries are exhausted.` });
    }
    return failure;
  }

  private async recordFailure(job: Job, error: JobError): Promise<void> {
    try {
      const failed = job.fail(error, this.deps.clock.now());
      await this.deps.jobs.save(failed);
      await this.deps.bus.publish({ type: "failed", jobId: job.id, error });
    } catch (cause) {
      this.deps.logger.error({ jobId: job.id, error: cause }, "could not record job failure");
    }
  }

  private static outputName(sourceName: string, spec: JobSpec, extension: string): string {
    const dot = sourceName.lastIndexOf(".");
    const base = (dot > 0 ? sourceName.slice(0, dot) : sourceName).slice(0, MAX_BASENAME);
    return `${base}-${spec.kind}.${extension}`;
  }
}
