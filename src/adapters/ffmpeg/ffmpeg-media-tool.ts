import { stat } from "node:fs/promises";
import { z } from "zod";
import { PermanentJobError, TransientJobError } from "../../domain/job-failure.js";
import { processedSeconds } from "../../domain/job-spec.js";
import type { MediaInfo, MediaOperation, MediaTool } from "../../ports/media-tool.js";
import type { CommandRunner } from "./command-runner.js";
import { buildFfmpegArgs } from "./ffmpeg-args.js";
import { FfmpegProgressParser } from "./progress-parser.js";

const probeSchema = z.object({
  streams: z.array(z.object({ codec_type: z.string(), duration: z.string().optional() })),
  format: z.object({ duration: z.string().optional() }),
});

const BAD_INPUT_SIGNATURES = [/invalid data found/i, /moov atom not found/i, /does not contain any stream/i];

/** MediaTool that shells out to ffprobe and ffmpeg. */
export class FfmpegMediaTool implements MediaTool {
  public constructor(
    private readonly runner: CommandRunner,
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
  ) {}

  public async probe(inputPath: string, signal?: AbortSignal): Promise<MediaInfo> {
    const result = await this.runner.run(
      this.ffprobePath,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", inputPath],
      signal === undefined ? {} : { signal },
    );
    if (result.exitCode !== 0) {
      throw new PermanentJobError("invalid_media", "The source file is not readable media.");
    }

    const parsed = probeSchema.safeParse(safeJson(result.stdout));
    if (!parsed.success || !parsed.data.streams.some((stream) => stream.codec_type === "video")) {
      throw new PermanentJobError("invalid_media", "The source file has no video stream.");
    }
    const duration = Number(parsed.data.format.duration ?? parsed.data.streams.find((s) => s.duration)?.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new PermanentJobError("invalid_media", "The source video has no usable duration.");
    }
    return { durationSeconds: duration };
  }

  public async execute(
    operation: MediaOperation,
    onProgress: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const parser = new FfmpegProgressParser(processedSeconds(operation.spec, operation.inputDurationSeconds));
    const result = await this.runner.run(this.ffmpegPath, buildFfmpegArgs(operation), {
      ...(signal === undefined ? {} : { signal }),
      onStdout: (chunk) => {
        for (const percent of parser.push(chunk)) {
          onProgress(percent);
        }
      },
    });

    if (result.exitCode !== 0) {
      if (BAD_INPUT_SIGNATURES.some((signature) => signature.test(result.stderr))) {
        throw new PermanentJobError("invalid_media", "The source file could not be decoded.");
      }
      throw new TransientJobError("ffmpeg_failed", `ffmpeg exited with code ${result.exitCode}.`, {
        cause: new Error(result.stderr),
      });
    }

    const output = await stat(operation.outputPath).catch(() => null);
    if (output === null || output.size === 0) {
      throw new PermanentJobError("empty_output", "The render produced no output; the requested range may be empty.");
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
