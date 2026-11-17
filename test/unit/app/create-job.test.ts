import { beforeEach, describe, expect, it } from "vitest";
import { CreateJob } from "../../../src/app/create-job.js";
import { Asset } from "../../../src/domain/asset.js";
import { ByteSize } from "../../../src/domain/byte-size.js";
import { ContentType } from "../../../src/domain/content-type.js";
import { Filename } from "../../../src/domain/filename.js";
import {
  FixedClock,
  InMemoryAssetRepository,
  InMemoryJobRepository,
  RecordingQueue,
  SequentialIds,
  silentLogger,
} from "../../support/fakes.js";

const now = new Date("2026-01-01T00:00:00.000Z");

function pendingAsset(id: string): Asset {
  return Asset.requestUpload({
    id,
    storageKey: `uploads/${id}`,
    filename: Filename.of("clip.mp4"),
    contentType: ContentType.video("video/mp4"),
    size: ByteSize.of(100),
    now,
  });
}

describe("CreateJob", () => {
  let assets: InMemoryAssetRepository;
  let jobs: InMemoryJobRepository;
  let queue: RecordingQueue;
  let createJob: CreateJob;

  beforeEach(() => {
    assets = new InMemoryAssetRepository();
    jobs = new InMemoryJobRepository();
    queue = new RecordingQueue();
    createJob = new CreateJob(assets, jobs, queue, new SequentialIds(), new FixedClock(), silentLogger);
  });

  it("stores a queued job and enqueues its id", async () => {
    await assets.insert(pendingAsset("a1").markUploaded(ByteSize.of(100), now));

    const jobId = await createJob.execute({ assetId: "a1", spec: { kind: "thumbnail", time: 3 } });

    expect(queue.enqueued).toEqual([jobId]);
    expect(jobs.rows.get(jobId)?.snapshot()).toMatchObject({ status: "queued", assetId: "a1", spec: { kind: "thumbnail", time: 3 } });
  });

  it("answers 404 for an unknown asset", async () => {
    await expect(createJob.execute({ assetId: "nope", spec: { kind: "thumbnail", time: 1 } })).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(queue.enqueued).toHaveLength(0);
  });

  it("answers 409 while the asset is still pending", async () => {
    await assets.insert(pendingAsset("a1"));

    await expect(createJob.execute({ assetId: "a1", spec: { kind: "thumbnail", time: 1 } })).rejects.toMatchObject({
      kind: "conflict",
      code: "asset_not_uploaded",
    });
    expect(jobs.rows.size).toBe(0);
  });

  it("rejects a spec that breaks the rules before writing anything", async () => {
    await assets.insert(pendingAsset("a1").markUploaded(ByteSize.of(100), now));

    await expect(createJob.execute({ assetId: "a1", spec: { kind: "trim", start: 9, end: 3 } })).rejects.toMatchObject({
      code: "invalid_range",
    });
    expect(jobs.rows.size).toBe(0);
  });

  it("removes the job and reports unavailable when the queue rejects it", async () => {
    await assets.insert(pendingAsset("a1").markUploaded(ByteSize.of(100), now));
    queue.failWith = new Error("redis down");

    await expect(createJob.execute({ assetId: "a1", spec: { kind: "transcode", preset: "h264-480p" } })).rejects.toMatchObject({
      kind: "unavailable",
      code: "queue_unavailable",
    });
    expect(jobs.rows.size).toBe(0);
  });
});
