import type { Clock, Logger } from "../ports/support.js";

/** Where a reporter sends each new whole percentage. */
export interface ProgressSink {
  /** Stores the percentage durably; the reporter calls it at most once per interval. */
  record(percent: number): Promise<void>;
  /** Broadcasts the percentage; the reporter calls it once per distinct whole value. */
  publish(percent: number): Promise<void>;
}

/** Turns a noisy stream of progress samples into ordered, de-duplicated, throttled updates. */
export class ProgressReporter {
  private lastReported = -1;
  private lastRecordedAt = Number.NEGATIVE_INFINITY;
  private chain: Promise<void> = Promise.resolve();

  public constructor(
    private readonly sink: ProgressSink,
    private readonly clock: Clock,
    private readonly recordIntervalMs: number,
    private readonly logger: Logger,
  ) {}

  /** Accepts a sample without blocking the caller. Samples that do not advance the whole percentage are dropped. */
  public report(percent: number): void {
    const whole = Math.min(100, Math.max(0, Math.floor(percent)));
    if (whole <= this.lastReported) {
      return;
    }
    this.lastReported = whole;
    this.chain = this.chain.then(() => this.deliver(whole));
  }

  /** Resolves once every accepted sample has been delivered. Never rejects. */
  public async drain(): Promise<void> {
    await this.chain;
  }

  private async deliver(percent: number): Promise<void> {
    try {
      const nowMs = this.clock.now().getTime();
      if (nowMs - this.lastRecordedAt >= this.recordIntervalMs) {
        this.lastRecordedAt = nowMs;
        await this.sink.record(percent);
      }
      await this.sink.publish(percent);
    } catch (error) {
      this.logger.warn({ error, percent }, "progress update failed");
    }
  }
}
