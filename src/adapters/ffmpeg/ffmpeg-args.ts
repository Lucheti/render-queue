import { assertNever } from "../../domain/assert-never.js";
import { processedSeconds, type TranscodePreset } from "../../domain/job-spec.js";
import type { MediaOperation } from "../../ports/media-tool.js";

const HEIGHT_BY_PRESET: Readonly<Record<TranscodePreset, number>> = {
  "h264-720p": 720,
  "h264-480p": 480,
};

const GLOBAL_ARGS = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-progress", "pipe:1", "-nostats"];
const H264_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"];
const AAC_ARGS = ["-c:a", "aac", "-b:a", "128k"];
const MP4_ARGS = ["-movflags", "+faststart"];

/** Builds the ffmpeg argument vector for an operation. Pure: no process is started here. */
export function buildFfmpegArgs(operation: MediaOperation): string[] {
  const { spec, inputPath, outputPath } = operation;
  switch (spec.kind) {
    case "thumbnail":
      return [...GLOBAL_ARGS, "-ss", String(spec.time), "-i", inputPath, "-frames:v", "1", "-q:v", "2", outputPath];
    case "transcode":
      return [
        ...GLOBAL_ARGS,
        "-i",
        inputPath,
        "-vf",
        `scale=-2:${HEIGHT_BY_PRESET[spec.preset]}`,
        ...H264_ARGS,
        ...AAC_ARGS,
        ...MP4_ARGS,
        outputPath,
      ];
    case "trim":
      return [
        ...GLOBAL_ARGS,
        "-ss",
        String(spec.start),
        "-i",
        inputPath,
        "-t",
        String(processedSeconds(spec, operation.inputDurationSeconds)),
        ...H264_ARGS,
        ...AAC_ARGS,
        ...MP4_ARGS,
        outputPath,
      ];
    default:
      return assertNever(spec);
  }
}
