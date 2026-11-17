import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandOptions, CommandResult, CommandRunner } from "../../../src/adapters/ffmpeg/command-runner.js";
import { buildFfmpegArgs } from "../../../src/adapters/ffmpeg/ffmpeg-args.js";
import { FfmpegMediaTool } from "../../../src/adapters/ffmpeg/ffmpeg-media-tool.js";
import { PermanentJobError, TransientJobError } from "../../../src/domain/job-failure.js";
import type { MediaOperation } from "../../../src/ports/media-tool.js";

const operation = (spec: MediaOperation["spec"], outputPath = "/work/out"): MediaOperation => ({
  spec,
  inputPath: "/work/in",
  outputPath,
  inputDurationSeconds: 100,
});

describe("buildFfmpegArgs", () => {
  it("seeks before the input and grabs one frame for a thumbnail", () => {
    const args = buildFfmpegArgs(operation({ kind: "thumbnail", time: 12.5 }, "/work/out.jpg"));

    expect(args).toEqual(
      expect.arrayContaining(["-ss", "12.5", "-i", "/work/in", "-frames:v", "1", "-progress", "pipe:1", "/work/out.jpg"]),
    );
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args.at(-1)).toBe("/work/out.jpg");
  });

  it.each([
    ["h264-720p", "scale=-2:720"],
    ["h264-480p", "scale=-2:480"],
  ] as const)("scales the %s preset to its height with H.264 and AAC", (preset, filter) => {
    const args = buildFfmpegArgs(operation({ kind: "transcode", preset }));

    expect(args).toEqual(expect.arrayContaining(["-vf", filter, "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"]));
  });

  it("limits a trim to its span and clamps the end to the media duration", () => {
    const inside = buildFfmpegArgs(operation({ kind: "trim", start: 10, end: 25 }));
    const beyond = buildFfmpegArgs(operation({ kind: "trim", start: 90, end: 500 }));

    expect(inside).toEqual(expect.arrayContaining(["-ss", "10", "-t", "15"]));
    expect(beyond).toEqual(expect.arrayContaining(["-ss", "90", "-t", "10"]));
  });

  it("never goes through a shell: every argument is its own element", () => {
    const args = buildFfmpegArgs({ ...operation({ kind: "thumbnail", time: 1 }), inputPath: "/work/a b; rm -rf x" });

    expect(args).toContain("/work/a b; rm -rf x");
  });
});

class StubRunner implements CommandRunner {
  public readonly calls: Array<{ command: string; args: readonly string[] }> = [];

  public constructor(private readonly respond: (command: string, options?: CommandOptions) => CommandResult) {}

  public async run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args });
    return this.respond(command, options);
  }
}

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const probeJson = (format: object, streams: object[]): string => JSON.stringify({ format, streams });

describe("FfmpegMediaTool.probe", () => {
  it("reads the duration from the container", async () => {
    const tool = new FfmpegMediaTool(
      new StubRunner(() => ok(probeJson({ duration: "12.480000" }, [{ codec_type: "video" }, { codec_type: "audio" }]))),
      "ffmpeg",
      "ffprobe",
    );

    await expect(tool.probe("/work/in")).resolves.toEqual({ durationSeconds: 12.48 });
  });

  it("falls back to the stream duration", async () => {
    const tool = new FfmpegMediaTool(
      new StubRunner(() => ok(probeJson({}, [{ codec_type: "video", duration: "7.5" }]))),
      "ffmpeg",
      "ffprobe",
    );

    await expect(tool.probe("/work/in")).resolves.toEqual({ durationSeconds: 7.5 });
  });

  it.each([
    ["ffprobe exits non-zero", { exitCode: 1, stdout: "", stderr: "Invalid data found when processing input" }],
    ["the output is not JSON", ok("not json")],
    ["there is no video stream", ok(probeJson({ duration: "5" }, [{ codec_type: "audio" }]))],
    ["there is no usable duration", ok(probeJson({}, [{ codec_type: "video" }]))],
    ["the duration is zero", ok(probeJson({ duration: "0" }, [{ codec_type: "video" }]))],
  ])("raises a permanent error when %s", async (_name, result) => {
    const tool = new FfmpegMediaTool(new StubRunner(() => result), "ffmpeg", "ffprobe");

    const failure = await tool.probe("/work/in").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PermanentJobError);
    expect(failure).toMatchObject({ code: "invalid_media" });
  });
});

describe("FfmpegMediaTool.execute", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "rq-ffmpeg-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("streams parsed progress while ffmpeg runs", async () => {
    const outputPath = join(directory, "out.mp4");
    const runner = new StubRunner((_command, options) => {
      options?.onStdout?.("out_time_us=25000000\nprogress=continue\nout_time_us=50000000\n");
      options?.onStdout?.("progress=end\n");
      return ok();
    });
    await writeFile(outputPath, "bytes");
    const percents: number[] = [];

    await new FfmpegMediaTool(runner, "ffmpeg", "ffprobe").execute(
      operation({ kind: "transcode", preset: "h264-720p" }, outputPath),
      (percent) => percents.push(percent),
    );

    expect(percents).toEqual([25, 50, 100]);
    expect(runner.calls[0]?.command).toBe("ffmpeg");
  });

  it("treats undecodable input as permanent", async () => {
    const runner = new StubRunner(() => ({ exitCode: 1, stdout: "", stderr: "x: Invalid data found when processing input" }));

    await expect(
      new FfmpegMediaTool(runner, "ffmpeg", "ffprobe").execute(operation({ kind: "transcode", preset: "h264-480p" }), () => undefined),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("treats any other non-zero exit as transient and keeps stderr as the cause", async () => {
    const runner = new StubRunner(() => ({ exitCode: 137, stdout: "", stderr: "Killed" }));

    const failure = await new FfmpegMediaTool(runner, "ffmpeg", "ffprobe")
      .execute(operation({ kind: "transcode", preset: "h264-480p" }), () => undefined)
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(TransientJobError);
    expect((failure as Error).cause).toEqual(new Error("Killed"));
  });

  it("raises a permanent error when ffmpeg succeeds but writes nothing", async () => {
    const runner = new StubRunner(() => ok());

    await expect(
      new FfmpegMediaTool(runner, "ffmpeg", "ffprobe").execute(
        operation({ kind: "thumbnail", time: 1 }, join(directory, "missing.jpg")),
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "empty_output" });
  });
});
