import { beforeEach, describe, expect, it } from "vitest";
import { GetJob } from "../../../src/app/get-job.js";
import { ProgressReporter } from "../../../src/app/progress-reporter.js";
import { WatchJob } from "../../../src/app/watch-job.js";
import { Asset } from "../../../src/domain/asset.js";
import { ByteSize } from "../../../src/domain/byte-size.js";
import { ContentType } from "../../../src/domain/content-type.js";
import type { JobEvent } from "../../../src/domain/job-event.js";
import { Filename } from "../../../src/domain/filename.js";
import { Job } from "../../../src/domain/job.js";
import {
  FixedClock,
  InMemoryAssetRepository,
  InMemoryJobRepository,
  InMemoryObjectStore,
  InMemoryProgressBus,
  silentLogger,
} from "../../support/fakes.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");
const spec = { kind: "transcode", preset: "h264-720p" } as const;

describe("GetJob", () => {
  let jobs: InMemoryJobRepository;
  let assets: InMemoryAssetRepository;
  let getJob: GetJob;

  beforeEach(() => {
    jobs = new InMemoryJobRepository();
    assets = new InMemoryAssetRepository();
    getJob = new GetJob(jobs, assets, new InMemoryObjectStore(), new FixedClock(t0), 3_600);
  });

  it("shows progress for a running job without a result", async () => {
    await jobs.insert(Job.enqueue({ id: "j1", assetId: "a1", spec, now: t0 }).startAttempt(t0).reportProgress(42));

    expect(await getJob.execute("j1")).toMatchObject({ id: "j1", kind: "transcode", status: "running", progress: 42, result: null, error: null });
  });

  it("signs a download URL for a completed job's result", async () => {
    await assets.insert(
      Asset.rendered({
        id: "j1",
        storageKey: "renders/j1/output.mp4",
        filename: Filename.of("out.mp4"),
        contentType: ContentType.of("video/mp4"),
        size: ByteSize.of(2_048),
        now: t0,
      }),
    );
    await jobs.insert(Job.enqueue({ id: "j1", assetId: "a1", spec, now: t0 }).startAttempt(t0).complete("j1", t0));

    const view = await getJob.execute("j1");

    expect(view.status).toBe("completed");
    expect(view.result).toEqual({
      assetId: "j1",
      filename: "out.mp4",
      contentType: "video/mp4",
      sizeBytes: 2_048,
      downloadUrl: "https://s3.test/renders/j1/output.mp4?signed=get",
      expiresAt: new Date("2026-01-01T01:00:00.000Z"),
    });
  });

  it("exposes the error of a failed job", async () => {
    await jobs.insert(
      Job.enqueue({ id: "j1", assetId: "a1", spec, now: t0 }).startAttempt(t0).fail({ code: "invalid_media", message: "bad" }, t0),
    );

    expect(await getJob.execute("j1")).toMatchObject({ status: "failed", error: { code: "invalid_media", message: "bad" } });
  });

  it("answers not found for an unknown id", async () => {
    await expect(getJob.execute("nope")).rejects.toMatchObject({ kind: "not_found", code: "job_not_found" });
  });
});

describe("WatchJob", () => {
  let jobs: InMemoryJobRepository;
  let bus: InMemoryProgressBus;
  let watchJob: WatchJob;
  let received: JobEvent[];

  beforeEach(() => {
    jobs = new InMemoryJobRepository();
    bus = new InMemoryProgressBus();
    watchJob = new WatchJob(jobs, bus);
    received = [];
  });

  it("starts with the stored progress and then relays live events", async () => {
    await jobs.insert(Job.enqueue({ id: "j1", assetId: "a1", spec, now: t0 }).startAttempt(t0).reportProgress(30));

    await watchJob.execute("j1", (event) => received.push(event));
    await bus.publish({ type: "progress", jobId: "j1", percent: 60 });

    expect(received).toEqual([
      { type: "progress", jobId: "j1", percent: 30 },
      { type: "progress", jobId: "j1", percent: 60 },
    ]);
  });

  it("starts with the terminal event for a job that already finished", async () => {
    await jobs.insert(Job.enqueue({ id: "j1", assetId: "a1", spec, now: t0 }).startAttempt(t0).complete("j1", t0));
    await jobs.insert(
      Job.enqueue({ id: "j2", assetId: "a1", spec, now: t0 }).startAttempt(t0).fail({ code: "invalid_media", message: "bad" }, t0),
    );

    await watchJob.execute("j1", (event) => received.push(event));
    await watchJob.execute("j2", (event) => received.push(event));

    expect(received).toEqual([
      { type: "completed", jobId: "j1" },
      { type: "failed", jobId: "j2", error: { code: "invalid_media", message: "bad" } },
    ]);
  });

  it("unsubscribes and reports not found for an unknown job", async () => {
    await expect(watchJob.execute("ghost", (event) => received.push(event))).rejects.toMatchObject({ kind: "not_found" });
    expect(bus.listenerCount("ghost")).toBe(0);
  });

  it("stops delivering after the subscription is closed", async () => {
    await jobs.insert(Job.enqueue({ id: "j1", assetId: "a1", spec, now: t0 }));
    const subscription = await watchJob.execute("j1", (event) => received.push(event));
    await subscription.close();

    await bus.publish({ type: "progress", jobId: "j1", percent: 10 });

    expect(received).toHaveLength(1);
  });
});

describe("ProgressReporter", () => {
  it("publishes each new whole percent once and records on an interval", async () => {
    const clock = new FixedClock(t0);
    const recorded: number[] = [];
    const published: number[] = [];
    const reporter = new ProgressReporter(
      { record: async (p) => void recorded.push(p), publish: async (p) => void published.push(p) },
      clock,
      1_000,
      silentLogger,
    );

    reporter.report(10.2);
    reporter.report(10.9);
    reporter.report(5);
    await reporter.drain();
    clock.advance(500);
    reporter.report(20);
    await reporter.drain();
    clock.advance(600);
    reporter.report(30);
    await reporter.drain();

    expect(published).toEqual([10, 20, 30]);
    expect(recorded).toEqual([10, 30]);
  });

  it("never rejects when the sink fails", async () => {
    const reporter = new ProgressReporter(
      { record: async () => Promise.reject(new Error("db down")), publish: async () => undefined },
      new FixedClock(t0),
      0,
      silentLogger,
    );

    reporter.report(50);

    await expect(reporter.drain()).resolves.toBeUndefined();
  });
});
