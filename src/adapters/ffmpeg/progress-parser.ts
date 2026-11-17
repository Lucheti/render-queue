const OUT_TIME_US = /^out_time_(?:us|ms)=(-?\d+)$/;

/**
 * Turns the `-progress pipe:1` stream of ffmpeg into percentages.
 * ffmpeg writes `key=value` lines; `out_time_us` (and the misnamed `out_time_ms`, also microseconds) is how far
 * the output has got, and `progress=end` closes the stream.
 */
export class FfmpegProgressParser {
  private pending = "";

  /** `totalSeconds` is the output duration that equals 100%. */
  public constructor(private readonly totalSeconds: number) {}

  /** Feeds a chunk of stdout and returns the percentages (0-100) it completed, in order. */
  public push(chunk: string): number[] {
    const lines = (this.pending + chunk).split("\n");
    this.pending = lines.pop() ?? "";

    const percents: number[] = [];
    for (const line of lines) {
      const percent = this.percentFor(line.trim());
      if (percent !== null) {
        percents.push(percent);
      }
    }
    return percents;
  }

  private percentFor(line: string): number | null {
    if (line === "progress=end") {
      return 100;
    }
    const match = OUT_TIME_US.exec(line);
    const microseconds = match?.[1];
    if (microseconds === undefined || this.totalSeconds <= 0) {
      return null;
    }
    const seconds = Number(microseconds) / 1_000_000;
    if (seconds < 0) {
      return null;
    }
    return Math.min(100, (seconds / this.totalSeconds) * 100);
  }
}
