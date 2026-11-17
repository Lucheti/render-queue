import { assertNever } from "./assert-never.js";
import { PermanentJobError } from "./job-failure.js";
import { ValidationError } from "./errors.js";

/** The transcode presets the service offers. */
export const TRANSCODE_PRESETS = ["h264-720p", "h264-480p"] as const;
export type TranscodePreset = (typeof TRANSCODE_PRESETS)[number];

/** Extract one JPEG frame at `time` seconds. */
export interface ThumbnailSpec {
  readonly kind: "thumbnail";
  readonly time: number;
}

/** Re-encode to H.264/AAC at the preset's resolution. */
export interface TranscodeSpec {
  readonly kind: "transcode";
  readonly preset: TranscodePreset;
}

/** Keep the span between `start` and `end` seconds. */
export interface TrimSpec {
  readonly kind: "trim";
  readonly start: number;
  readonly end: number;
}

/** What a render job does; the `kind` field is the discriminant. */
export type JobSpec = ThumbnailSpec | TranscodeSpec | TrimSpec;
export type JobKind = JobSpec["kind"];

/** The file a job produces. */
export interface OutputDescriptor {
  readonly contentType: string;
  readonly extension: string;
}

/** Throws a ValidationError when the spec breaks a rule that does not depend on the media. */
export function assertValidSpec(spec: JobSpec): void {
  switch (spec.kind) {
    case "thumbnail":
      requireSeconds("time", spec.time);
      return;
    case "transcode":
      if (!TRANSCODE_PRESETS.includes(spec.preset)) {
        throw new ValidationError("invalid_preset", `Unknown transcode preset "${String(spec.preset)}".`);
      }
      return;
    case "trim":
      requireSeconds("start", spec.start);
      requireSeconds("end", spec.end);
      if (spec.end <= spec.start) {
        throw new ValidationError("invalid_range", "Trim end must be greater than start.");
      }
      return;
    default:
      return assertNever(spec);
  }
}

/** Describes the output file for a spec. */
export function describeOutput(spec: JobSpec): OutputDescriptor {
  switch (spec.kind) {
    case "thumbnail":
      return { contentType: "image/jpeg", extension: "jpg" };
    case "transcode":
    case "trim":
      return { contentType: "video/mp4", extension: "mp4" };
    default:
      return assertNever(spec);
  }
}

/** Seconds of input the operation consumes; this is the denominator for progress. */
export function processedSeconds(spec: JobSpec, inputDurationSeconds: number): number {
  switch (spec.kind) {
    case "thumbnail":
      return 1;
    case "transcode":
      return inputDurationSeconds;
    case "trim":
      return Math.min(spec.end, inputDurationSeconds) - spec.start;
    default:
      return assertNever(spec);
  }
}

/** Throws a PermanentJobError when the spec points outside the probed media. */
export function assertFitsMedia(spec: JobSpec, inputDurationSeconds: number): void {
  switch (spec.kind) {
    case "thumbnail":
      if (spec.time >= inputDurationSeconds) {
        throw new PermanentJobError(
          "time_out_of_range",
          `Thumbnail time ${spec.time}s is beyond the ${inputDurationSeconds.toFixed(2)}s video.`,
        );
      }
      return;
    case "transcode":
      return;
    case "trim":
      if (spec.start >= inputDurationSeconds) {
        throw new PermanentJobError(
          "range_out_of_range",
          `Trim start ${spec.start}s is beyond the ${inputDurationSeconds.toFixed(2)}s video.`,
        );
      }
      return;
    default:
      return assertNever(spec);
  }
}

function requireSeconds(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ValidationError("invalid_time", `"${field}" must be a number of seconds >= 0.`);
  }
}
