import { describe, expect, it } from "vitest";
import { ByteSize } from "../../../src/domain/byte-size.js";
import { ContentType } from "../../../src/domain/content-type.js";
import { ValidationError } from "../../../src/domain/errors.js";
import { Filename } from "../../../src/domain/filename.js";

describe("ContentType", () => {
  it("accepts video types and normalises case", () => {
    expect(ContentType.video("Video/MP4").toString()).toBe("video/mp4");
    expect(ContentType.video("video/quicktime").toString()).toBe("video/quicktime");
  });

  it.each(["image/png", "audio/mpeg", "application/octet-stream"])("rejects %s as an upload type", (raw) => {
    expect(() => ContentType.video(raw)).toThrowError(expect.objectContaining({ code: "unsupported_content_type" }));
  });

  it.each(["video", "video/", "video/mp4; codecs=avc1", "", "video/mp4 extra"])("rejects malformed %j", (raw) => {
    expect(() => ContentType.of(raw)).toThrow(ValidationError);
  });

  it("parses non-video types when asked generically", () => {
    expect(ContentType.of("image/jpeg").toString()).toBe("image/jpeg");
  });
});

describe("ByteSize", () => {
  const limit = ByteSize.of(1_000);

  it("accepts sizes up to and including the limit", () => {
    expect(ByteSize.of(1, limit).toNumber()).toBe(1);
    expect(ByteSize.of(1_000, limit).toNumber()).toBe(1_000);
  });

  it("rejects sizes above the limit", () => {
    expect(() => ByteSize.of(1_001, limit)).toThrowError(expect.objectContaining({ code: "size_limit_exceeded" }));
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (bytes) => {
    expect(() => ByteSize.of(bytes)).toThrowError(expect.objectContaining({ code: "invalid_size" }));
  });
});

describe("Filename", () => {
  it("trims and keeps ordinary names", () => {
    expect(Filename.of("  holiday cut.mp4 ").toString()).toBe("holiday cut.mp4");
  });

  it.each(["", "   ", "a/b.mp4", "..\\evil.mp4", "tab\tname.mp4", "..", ".", "x".repeat(256)])(
    "rejects %j",
    (raw) => {
      expect(() => Filename.of(raw)).toThrowError(expect.objectContaining({ code: "invalid_filename" }));
    },
  );
});
