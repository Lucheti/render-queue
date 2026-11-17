import { describe, expect, it } from "vitest";
import { FfmpegProgressParser } from "../../../src/adapters/ffmpeg/progress-parser.js";

const block = (outTimeUs: number, status = "continue"): string =>
  [
    "frame=120",
    "fps=30.00",
    "stream_0_0_q=28.0",
    "bitrate=1500.2kbits/s",
    "total_size=1048576",
    `out_time_us=${outTimeUs}`,
    `out_time_ms=${outTimeUs}`,
    "out_time=00:00:04.000000",
    "dup_frames=0",
    "drop_frames=0",
    "speed=2.1x",
    `progress=${status}`,
    "",
  ].join("\n");

describe("FfmpegProgressParser", () => {
  it("converts out_time into a percentage of the total duration", () => {
    const parser = new FfmpegProgressParser(40);

    expect(parser.push(block(4_000_000))).toEqual([10, 10]);
  });

  it("reports 100 on progress=end", () => {
    const parser = new FfmpegProgressParser(40);

    expect(parser.push("progress=end\n")).toEqual([100]);
  });

  it("clamps overshoot to 100", () => {
    const parser = new FfmpegProgressParser(10);

    expect(parser.push("out_time_us=12000000\n")).toEqual([100]);
  });

  it("reassembles lines split across chunks", () => {
    const parser = new FfmpegProgressParser(10);

    expect(parser.push("frame=1\nout_time_")).toEqual([]);
    expect(parser.push("us=2500")).toEqual([]);
    expect(parser.push("000\nprogress=continue\n")).toEqual([25]);
  });

  it("ignores N/A and negative timestamps that ffmpeg emits before the first frame", () => {
    const parser = new FfmpegProgressParser(10);

    expect(parser.push("out_time_us=N/A\nout_time_us=-9223372036854775807\nout_time=N/A\n")).toEqual([]);
  });

  it("ignores unrelated keys and a zero total", () => {
    expect(new FfmpegProgressParser(10).push("frame=3\nspeed=1x\n")).toEqual([]);
    expect(new FfmpegProgressParser(0).push("out_time_us=1000000\n")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    expect(new FfmpegProgressParser(10).push("out_time_us=5000000\r\n")).toEqual([50]);
  });
});
