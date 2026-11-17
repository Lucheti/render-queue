import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../../src/adapters/drizzle/database.js";
import { DrizzleAssetRepository } from "../../src/adapters/drizzle/drizzle-asset-repository.js";
import { DrizzleJobRepository } from "../../src/adapters/drizzle/drizzle-job-repository.js";
import { PostgresHealthCheck } from "../../src/adapters/drizzle/postgres-health-check.js";
import { Asset } from "../../src/domain/asset.js";
import { ByteSize } from "../../src/domain/byte-size.js";
import { ContentType } from "../../src/domain/content-type.js";
import { Filename } from "../../src/domain/filename.js";
import { Job } from "../../src/domain/job.js";
import { integrationEnv, resetDatabase } from "./support.js";

const now = new Date("2026-01-01T00:00:00.000Z");

function pendingAsset(id = randomUUID()): Asset {
  return Asset.requestUpload({
    id,
    storageKey: `uploads/${id}`,
    filename: Filename.of("clip.mp4"),
    contentType: ContentType.video("video/mp4"),
    size: ByteSize.of(1234),
    now,
  });
}

describe("Drizzle repositories on Postgres", () => {
  let handle: DatabaseHandle;
  let assets: DrizzleAssetRepository;
  let jobs: DrizzleJobRepository;

  beforeAll(() => {
    handle = openDatabase({ connectionString: integrationEnv.DATABASE_URL, ssl: false, poolSize: 4 });
    assets = new DrizzleAssetRepository(handle.db);
    jobs = new DrizzleJobRepository(handle.db);
  });

  beforeEach(async () => {
    await resetDatabase(handle.db, handle.pool);
  });

  afterAll(async () => {
    await handle.pool.end();
  });

  it("round-trips an asset and persists its transition to uploaded", async () => {
    const asset = pendingAsset();
    await assets.insert(asset);
    expect((await assets.findById(asset.id))?.snapshot()).toEqual(asset.snapshot());

    const uploaded = asset.markUploaded(ByteSize.of(1200), new Date("2026-01-01T00:01:00.000Z"));
    await assets.save(uploaded);

    expect((await assets.findById(asset.id))?.snapshot()).toMatchObject({
      status: "uploaded",
      sizeBytes: 1200,
      uploadedAt: new Date("2026-01-01T00:01:00.000Z"),
    });
    expect(await assets.findById(randomUUID())).toBeNull();
  });

  it("round-trips a job through every state, keeping the spec as typed JSON", async () => {
    const asset = pendingAsset();
    await assets.insert(asset);
    const queued = Job.enqueue({ id: randomUUID(), assetId: asset.id, spec: { kind: "trim", start: 1.5, end: 9 }, now });
    await jobs.insert(queued);
    expect((await jobs.findById(queued.id))?.snapshot()).toEqual(queued.snapshot());

    const running = queued.startAttempt(now).reportProgress(40);
    await jobs.save(running);
    expect((await jobs.findById(queued.id))?.snapshot()).toMatchObject({
      status: "running",
      progress: 40,
      attempts: 1,
      spec: { kind: "trim", start: 1.5, end: 9 },
    });

    const failed = running.fail({ code: "invalid_media", message: "bad" }, now);
    await jobs.save(failed);
    expect((await jobs.findById(queued.id))?.snapshot()).toMatchObject({
      status: "failed",
      error: { code: "invalid_media", message: "bad" },
      finishedAt: now,
    });
  });

  it("links a completed job to its result asset", async () => {
    const source = pendingAsset();
    const jobId = randomUUID();
    const result = Asset.rendered({
      id: jobId,
      storageKey: `renders/${jobId}/output.mp4`,
      filename: Filename.of("out.mp4"),
      contentType: ContentType.of("video/mp4"),
      size: ByteSize.of(10),
      now,
    });
    await assets.insert(source);
    await assets.insert(result);
    const done = Job.enqueue({ id: jobId, assetId: source.id, spec: { kind: "transcode", preset: "h264-720p" }, now })
      .startAttempt(now)
      .complete(jobId, now);
    await jobs.insert(done);

    expect((await jobs.findById(jobId))?.snapshot()).toMatchObject({ status: "completed", progress: 100, resultAssetId: jobId });
  });

  it("enforces the foreign key from jobs to assets", async () => {
    const orphan = Job.enqueue({ id: randomUUID(), assetId: randomUUID(), spec: { kind: "thumbnail", time: 1 }, now });

    await expect(jobs.insert(orphan)).rejects.toThrow();
  });

  it("deletes a job", async () => {
    const asset = pendingAsset();
    await assets.insert(asset);
    const job = Job.enqueue({ id: randomUUID(), assetId: asset.id, spec: { kind: "thumbnail", time: 1 }, now });
    await jobs.insert(job);

    await jobs.delete(job.id);

    expect(await jobs.findById(job.id)).toBeNull();
  });

  it("answers the readiness probe", async () => {
    await expect(new PostgresHealthCheck(handle.pool).check()).resolves.toBeUndefined();
  });
});
