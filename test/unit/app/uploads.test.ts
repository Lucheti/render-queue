import { beforeEach, describe, expect, it } from "vitest";
import { CompleteUpload } from "../../../src/app/complete-upload.js";
import { CreateUpload } from "../../../src/app/create-upload.js";
import { ByteSize } from "../../../src/domain/byte-size.js";
import {
  FixedClock,
  InMemoryAssetRepository,
  InMemoryObjectStore,
  SequentialIds,
} from "../../support/fakes.js";

const maxSize = ByteSize.of(1_000_000);

describe("CreateUpload and CompleteUpload", () => {
  let assets: InMemoryAssetRepository;
  let store: InMemoryObjectStore;
  let clock: FixedClock;
  let createUpload: CreateUpload;
  let completeUpload: CompleteUpload;

  beforeEach(() => {
    assets = new InMemoryAssetRepository();
    store = new InMemoryObjectStore();
    clock = new FixedClock();
    createUpload = new CreateUpload(assets, store, new SequentialIds(), clock, { maxSize, urlTtlSeconds: 600 });
    completeUpload = new CompleteUpload(assets, store, clock, maxSize);
  });

  it("registers a pending asset and signs an upload bound to type and size", async () => {
    const result = await createUpload.execute({ filename: "clip.mp4", contentType: "video/mp4", size: 5_000 });

    expect(result.uploadUrl).toBe(`https://s3.test/uploads/${result.assetId}?signed=put`);
    expect(result.uploadHeaders).toEqual({ "Content-Type": "video/mp4" });
    expect(result.expiresAt).toEqual(new Date("2026-01-01T00:10:00.000Z"));
    expect(store.presigned).toEqual([{ key: `uploads/${result.assetId}`, contentType: "video/mp4", sizeBytes: 5_000 }]);
    expect(assets.rows.get(result.assetId)?.snapshot()).toMatchObject({
      status: "pending",
      origin: "upload",
      filename: "clip.mp4",
      sizeBytes: 5_000,
    });
  });

  it.each([
    ["a non-video type", { filename: "a.png", contentType: "image/png", size: 10 }, "unsupported_content_type"],
    ["a size over the limit", { filename: "a.mp4", contentType: "video/mp4", size: 1_000_001 }, "size_limit_exceeded"],
    ["a zero size", { filename: "a.mp4", contentType: "video/mp4", size: 0 }, "invalid_size"],
    ["a path in the filename", { filename: "../a.mp4", contentType: "video/mp4", size: 10 }, "invalid_filename"],
  ])("rejects %s without touching storage or the database", async (_name, command, code) => {
    await expect(createUpload.execute(command)).rejects.toMatchObject({ kind: "validation", code });
    expect(store.presigned).toHaveLength(0);
    expect(assets.rows.size).toBe(0);
  });

  it("completes an upload once the object exists, recording its real size", async () => {
    const { assetId } = await createUpload.execute({ filename: "clip.mp4", contentType: "video/mp4", size: 5_000 });
    store.objects.set(`uploads/${assetId}`, { sizeBytes: 4_990 });

    const completed = await completeUpload.execute(assetId);

    expect(completed).toMatchObject({ status: "uploaded", sizeBytes: 4_990, uploadedAt: clock.now() });
    expect(assets.rows.get(assetId)?.isUploaded()).toBe(true);
  });

  it("is idempotent", async () => {
    const { assetId } = await createUpload.execute({ filename: "clip.mp4", contentType: "video/mp4", size: 5_000 });
    store.objects.set(`uploads/${assetId}`, { sizeBytes: 5_000 });
    const first = await completeUpload.execute(assetId);
    store.objects.delete(`uploads/${assetId}`);

    await expect(completeUpload.execute(assetId)).resolves.toEqual(first);
  });

  it("answers 409 when the object has not been uploaded yet", async () => {
    const { assetId } = await createUpload.execute({ filename: "clip.mp4", contentType: "video/mp4", size: 5_000 });

    await expect(completeUpload.execute(assetId)).rejects.toMatchObject({ kind: "conflict", code: "upload_missing" });
    expect(assets.rows.get(assetId)?.isUploaded()).toBe(false);
  });

  it("rejects an object that is bigger than the limit", async () => {
    const { assetId } = await createUpload.execute({ filename: "clip.mp4", contentType: "video/mp4", size: 5_000 });
    store.objects.set(`uploads/${assetId}`, { sizeBytes: 2_000_000 });

    await expect(completeUpload.execute(assetId)).rejects.toMatchObject({ code: "size_limit_exceeded" });
  });

  it("answers 404 for an unknown asset", async () => {
    await expect(completeUpload.execute("missing")).rejects.toMatchObject({ kind: "not_found", code: "asset_not_found" });
  });
});
