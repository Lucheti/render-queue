import { beforeEach, describe, expect, it } from "vitest";
import { RunJob } from "../../../src/app/run-job.js";
import { Asset } from "../../../src/domain/asset.js";
import { ByteSize } from "../../../src/domain/byte-size.js";
import { ContentType } from "../../../src/domain/content-type.js";
import { Filename } from "../../../src/domain/filename.js";
import { Job } from "../../../src/domain/job.js";
import { JobAbortedError, PermanentJobError, TransientJobError } from "../../../src/domain/job-failure.js";
import type { JobSpec } from "../../../src/domain/job-spec.js";
import {
  FixedClock,
  InMemoryAssetRepository,
  InMemoryJobRepository,
  InMemoryObjectStore,
  InMemoryProgressBus,
  ScriptedMediaTool,
  silentLogger,
  TempWorkspaceProvider,
} from "../../support/fakes.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const JOB_ID = "job-1";
const SOURCE_ID = "source-1";

describe("RunJob", () => {
  let jobs: InMemoryJobRepository;
  let assets: InMemoryAssetRepository;
  let store: InMemoryObjectStore;
  let media: ScriptedMediaTool;
  let bus: InMemoryProgressBus;
  let workspaces: TempWorkspaceProvider;
  let runJob: RunJob;
  const signal = new AbortController().signal;

  async function seed(spec: JobSpec, options: { running?: boolean } = {}): Promise<void> {
    await assets.insert(
      Asset.requestUpload({
        id: SOURCE_ID,
        storageKey: `uploads/${SOURCE_ID}`,
        filename: Filename.of("holiday.mov"),
        contentType: ContentType.video("video/quicktime"),
        size: ByteSize.of(100),
        now,
      }).markUploaded(ByteSize.of(100), now),
    );
    store.objects.set(`uploads/${SOURCE_ID}`, { sizeBytes: 100 });
    const queued = Job.enqueue({ id: JOB_ID, assetId: SOURCE_ID, spec, now });
    await jobs.insert(options.running === true ? queued.startAttempt(now) : queued);
  }

  beforeEach(() => {
    jobs = new InMemoryJobRepository();
    assets = new InMemoryAssetRepository();
    store = new InMemoryObjectStore();
    media = new ScriptedMediaTool();
    bus = new InMemoryProgressBus();
    workspaces = new TempWorkspaceProvider();
    runJob = new RunJob({
      jobs,
      assets,
      store,
      media,
      bus,
      workspaces,
      clock: new FixedClock(now),
      logger: silentLogger,
      progressRecordIntervalMs: 0,
    });
  });

  it("downloads, renders, uploads, records the result and announces completion", async () => {
    await seed({ kind: "transcode", preset: "h264-720p" });

    await runJob.execute({ jobId: JOB_ID, isFinalAttempt: false }, signal);

    const job = jobs.rows.get(JOB_ID)?.snapshot();
    expect(job).toMatchObject({ status: "completed", progress: 100, attempts: 1, resultAssetId: JOB_ID, error: null });
    expect(store.objects.get(`renders/${JOB_ID}/output.mp4`)).toMatchObject({ contentType: "video/mp4" });
    expect(assets.rows.get(JOB_ID)?.snapshot()).toMatchObject({
      origin: "render",
      status: "uploaded",
      filename: "holiday-transcode.mp4",
      contentType: "video/mp4",
      storageKey: `renders/${JOB_ID}/output.mp4`,
    });
    expect(bus.published).toEqual([
      { type: "progress", jobId: JOB_ID, percent: 10 },
      { type: "progress", jobId: JOB_ID, percent: 50 },
      { type: "progress", jobId: JOB_ID, percent: 99 },
      { type: "completed", jobId: JOB_ID },
    ]);
    expect(jobs.history.map((j) => j.snapshot().status)).toEqual(["running", "running", "running", "running", "completed"]);
    expect(workspaces.disposed).toEqual(workspaces.created);
  });

  it("renders a thumbnail as a jpeg", async () => {
    await seed({ kind: "thumbnail", time: 5 });

    await runJob.execute({ jobId: JOB_ID, isFinalAttempt: false }, signal);

    expect(store.objects.get(`renders/${JOB_ID}/output.jpg`)).toMatchObject({ contentType: "image/jpeg" });
    expect(media.operations[0]).toMatchObject({ spec: { kind: "thumbnail", time: 5 }, inputDurationSeconds: 60 });
  });

  it("persists progress no more often than the configured interval", async () => {
    const clock = new FixedClock(now);
    runJob = new RunJob({
      jobs,
      assets,
      store,
      media,
      bus,
      workspaces,
      clock,
      logger: silentLogger,
      progressRecordIntervalMs: 60_000,
    });
    await seed({ kind: "transcode", preset: "h264-480p" });

    await runJob.execute({ jobId: JOB_ID, isFinalAttempt: false }, signal);

    expect(bus.published.filter((e) => e.type === "progress")).toHaveLength(3);
    expect(jobs.history.filter((j) => j.snapshot().status === "running")).toHaveLength(2);
  });

  it("fails permanently on bad input, records it, announces it and does not ask for a retry", async () => {
    await seed({ kind: "transcode", preset: "h264-720p" });
    media.probeError = new PermanentJobError("invalid_media", "The source file is not readable media.");

    await expect(runJob.execute({ jobId: JOB_ID, isFinalAttempt: false }, signal)).rejects.toBeInstanceOf(PermanentJobError);

    expect(jobs.rows.get(JOB_ID)?.snapshot()).toMatchObject({
      status: "failed",
      error: { code: "invalid_media", message: "The source file is not readable media." },
    });
    expect(bus.published.at(-1)).toEqual({
      type: "failed",
      jobId: JOB_ID,
      error: { code: "invalid_media", message: "The source file is not readable media." },
    });
    expect(workspaces.disposed).toEqual(workspaces.created);
  });

  it("fails permanently when a trim starts beyond the video", async () => {
    await seed({ kind: "trim", start: 120, end: 130 });

    await expect(runJob.execute({ jobId: JOB_ID, isFinalAttempt: false }, signal)).rejects.toMatchObject({
      code: "range_out_of_range",
    });
    expect(jobs.rows.get(JOB_ID)?.snapshot().status).toBe("failed");
    expect(media.operations).toHaveLength(0);
  });

  it("fails permanently when the source asset is gone", async () => {
    await seed({ kind: "transcode", preset: "h264-720p" });
    assets.rows.delete(SOURCE_ID);

    await expect(runJob.execute({ jobId: JOB_ID, isFinalAttempt: false }, signal)).rejects.toMatchObject({
      code: "source_unavailable",
    });
  });

  it("leaves the job running and unannounced when a transient failure will be retried", async () => {
    await seed({ kind: "transcode", preset: "h264-720p" });
    media.executeError = new TransientJobError("ffmpeg_failed", "ffmpeg exited with code 1.");

    await expect(runJob.execute({ jobId: JOB_ID, isFinalAttempt: false }, signal)).rejects.toBeInstanceOf(TransientJobError);

    expect(jobs.rows.get(JOB_ID)?.snapshot()).toMatchObject({ status: "running", attempts: 1 });
    expect(bus.published.some((e) => e.type === "failed")).toBe(false);
  });

  it("records the failure once the final attempt fails", async () => {
    await seed({ kind: "transcode", preset: "h264-720p" });
    media.executeError = new TransientJobError("ffmpeg_failed", "ffmpeg exited with code 1.");

    await expect(runJob.execute({ jobId: JOB_ID, isFinalAttempt: true }, signal)).rejects.toBeInstanceOf(TransientJobError);

    expect(jobs.rows.get(JOB_ID)?.snapshot()).toMatchObject({
      status: "failed",
      error: { code: "ffmpeg_failed", message: "ffmpeg exited with code 1. Retries are exhausted." },
    });
    expect(bus.published.at(-1)).toMatchObject({ type: "failed", jobId: JOB_ID });
  });

  it("treats an unexpected error as transient without leaking its message", async () => {
    await seed({ kind: "transcode", preset: "h264-720p" });
    media.executeError = new Error("connect ECONNRESET 10.0.0.5:5432");

    const failure = await runJob.execute({ jobId: JOB_ID, isFinalAttempt: true }, signal).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(TransientJobError);
    expect(jobs.rows.get(JOB_ID)?.snapshot().error?.message).not.toContain("10.0.0.5");
    expect(jobs.rows.get(JOB_ID)?.snapshot().error?.code).toBe("render_failed");
  });

  it("hands the job back untouched when the worker is shutting down", async () => {
    await seed({ kind: "transcode", preset: "h264-720p" });
    media.executeError = new JobAbortedError();

    await expect(runJob.execute({ jobId: JOB_ID, isFinalAttempt: true }, signal)).rejects.toBeInstanceOf(JobAbortedError);

    expect(jobs.rows.get(JOB_ID)?.snapshot().status).toBe("running");
    expect(bus.published.some((e) => e.type === "failed" || e.type === "completed")).toBe(false);
    expect(workspaces.disposed).toEqual(workspaces.created);
  });

  it("skips a job that already finished, so a duplicate delivery does no work", async () => {
    await seed({ kind: "transcode", preset: "h264-720p" });
    await runJob.execute({ jobId: JOB_ID, isFinalAttempt: false }, signal);
    const publishedBefore = bus.published.length;

    await runJob.execute({ jobId: JOB_ID, isFinalAttempt: false }, signal);

    expect(media.operations).toHaveLength(1);
    expect(bus.published).toHaveLength(publishedBefore);
  });

  it("picks up a job left running by a crashed worker as a new attempt", async () => {
    await seed({ kind: "transcode", preset: "h264-720p" }, { running: true });

    await runJob.execute({ jobId: JOB_ID, isFinalAttempt: false }, signal);

    expect(jobs.rows.get(JOB_ID)?.snapshot()).toMatchObject({ status: "completed", attempts: 2 });
  });

  it("does not duplicate the result asset when it already exists from a crashed attempt", async () => {
    await seed({ kind: "transcode", preset: "h264-720p" }, { running: true });
    const existing = Asset.rendered({
      id: JOB_ID,
      storageKey: `renders/${JOB_ID}/output.mp4`,
      filename: Filename.of("holiday-transcode.mp4"),
      contentType: ContentType.of("video/mp4"),
      size: ByteSize.of(5),
      now,
    });
    await assets.insert(existing);

    await runJob.execute({ jobId: JOB_ID, isFinalAttempt: false }, signal);

    expect(assets.rows.get(JOB_ID)).toBe(existing);
    expect(jobs.rows.get(JOB_ID)?.snapshot().status).toBe("completed");
  });

  it("rejects a job id it has never heard of as permanent", async () => {
    await expect(runJob.execute({ jobId: "ghost", isFinalAttempt: false }, signal)).rejects.toMatchObject({
      code: "job_not_found",
    });
  });
});
