import { describe, expect, it } from "vitest";
import { Asset } from "../../../src/domain/asset.js";
import { ByteSize } from "../../../src/domain/byte-size.js";
import { ContentType } from "../../../src/domain/content-type.js";
import { Filename } from "../../../src/domain/filename.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");
const t1 = new Date("2026-01-01T00:05:00.000Z");

const pending = (): Asset =>
  Asset.requestUpload({
    id: "a1",
    storageKey: "uploads/a1",
    filename: Filename.of("clip.mp4"),
    contentType: ContentType.video("video/mp4"),
    size: ByteSize.of(1_000),
    now: t0,
  });

describe("Asset", () => {
  it("starts pending with the declared size", () => {
    expect(pending().snapshot()).toMatchObject({ status: "pending", origin: "upload", sizeBytes: 1_000, uploadedAt: null });
    expect(pending().isUploaded()).toBe(false);
  });

  it("becomes uploaded with the verified size, leaving the original untouched", () => {
    const original = pending();

    const uploaded = original.markUploaded(ByteSize.of(990), t1);

    expect(uploaded.snapshot()).toMatchObject({ status: "uploaded", sizeBytes: 990, uploadedAt: t1 });
    expect(uploaded.isUploaded()).toBe(true);
    expect(original.snapshot().status).toBe("pending");
  });

  it("can only be marked uploaded once", () => {
    const uploaded = pending().markUploaded(ByteSize.of(990), t1);

    expect(() => uploaded.markUploaded(ByteSize.of(990), t1)).toThrowError(
      expect.objectContaining({ kind: "conflict", code: "asset_already_uploaded" }),
    );
  });

  it("is born uploaded when the worker renders it", () => {
    const rendered = Asset.rendered({
      id: "j1",
      storageKey: "renders/j1/output.mp4",
      filename: Filename.of("out.mp4"),
      contentType: ContentType.of("video/mp4"),
      size: ByteSize.of(5),
      now: t1,
    });

    expect(rendered.snapshot()).toMatchObject({ origin: "render", status: "uploaded", uploadedAt: t1 });
  });
});
