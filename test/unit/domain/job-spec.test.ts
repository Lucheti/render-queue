import { describe, expect, it } from "vitest";
import { PermanentJobError } from "../../../src/domain/job-failure.js";
import {
  assertFitsMedia,
  assertValidSpec,
  describeOutput,
  processedSeconds,
  type JobSpec,
} from "../../../src/domain/job-spec.js";

describe("assertValidSpec", () => {
  it("accepts well-formed specs", () => {
    const specs: JobSpec[] = [
      { kind: "thumbnail", time: 0 },
      { kind: "transcode", preset: "h264-480p" },
      { kind: "trim", start: 1, end: 2.5 },
    ];
    for (const spec of specs) {
      expect(() => assertValidSpec(spec)).not.toThrow();
    }
  });

  it.each<[string, JobSpec, string]>([
    ["negative thumbnail time", { kind: "thumbnail", time: -1 }, "invalid_time"],
    ["non-finite thumbnail time", { kind: "thumbnail", time: Number.NaN }, "invalid_time"],
    ["unknown preset", { kind: "transcode", preset: "h264-4k" as never }, "invalid_preset"],
    ["end equal to start", { kind: "trim", start: 5, end: 5 }, "invalid_range"],
    ["end before start", { kind: "trim", start: 5, end: 2 }, "invalid_range"],
    ["negative start", { kind: "trim", start: -1, end: 2 }, "invalid_time"],
  ])("rejects %s", (_name, spec, code) => {
    expect(() => assertValidSpec(spec)).toThrowError(expect.objectContaining({ code }));
  });
});

describe("describeOutput", () => {
  it("maps each kind to its output file type", () => {
    expect(describeOutput({ kind: "thumbnail", time: 1 })).toEqual({ contentType: "image/jpeg", extension: "jpg" });
    expect(describeOutput({ kind: "transcode", preset: "h264-720p" })).toEqual({ contentType: "video/mp4", extension: "mp4" });
    expect(describeOutput({ kind: "trim", start: 0, end: 1 })).toEqual({ contentType: "video/mp4", extension: "mp4" });
  });
});

describe("assertFitsMedia", () => {
  it("rejects a thumbnail past the end of the video as permanent", () => {
    expect(() => assertFitsMedia({ kind: "thumbnail", time: 30 }, 30)).toThrow(PermanentJobError);
    expect(() => assertFitsMedia({ kind: "thumbnail", time: 29.9 }, 30)).not.toThrow();
  });

  it("rejects a trim that starts after the end of the video", () => {
    expect(() => assertFitsMedia({ kind: "trim", start: 40, end: 50 }, 30)).toThrow(PermanentJobError);
  });

  it("lets a trim run past the end; it is clamped", () => {
    expect(() => assertFitsMedia({ kind: "trim", start: 10, end: 50 }, 30)).not.toThrow();
  });
});

describe("processedSeconds", () => {
  it("is the denominator used for progress", () => {
    expect(processedSeconds({ kind: "transcode", preset: "h264-720p" }, 90)).toBe(90);
    expect(processedSeconds({ kind: "trim", start: 10, end: 20 }, 90)).toBe(10);
    expect(processedSeconds({ kind: "trim", start: 10, end: 200 }, 90)).toBe(80);
  });
});
