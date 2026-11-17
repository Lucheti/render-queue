import type { Redis } from "ioredis";
import { z } from "zod";
import type { JobEvent } from "../../domain/job-event.js";
import type { ProgressBus, Subscription } from "../../ports/progress-bus.js";
import type { Logger } from "../../ports/support.js";

const jobEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), jobId: z.string(), percent: z.number() }),
  z.object({ type: z.literal("completed"), jobId: z.string() }),
  z.object({
    type: z.literal("failed"),
    jobId: z.string(),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

interface Channel {
  readonly listeners: Set<(event: JobEvent) => void>;
  readonly ready: Promise<unknown>;
}

/** ProgressBus over Redis pub/sub: one channel per job, one shared subscriber connection per process. */
export class RedisProgressBus implements ProgressBus {
  private readonly channels = new Map<string, Channel>();

  /** `subscriber` must be a dedicated connection: a client in subscriber mode cannot run other commands. */
  public constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    private readonly logger: Logger,
  ) {
    this.subscriber.on("message", (channel: string, payload: string) => this.dispatch(channel, payload));
  }

  public async publish(event: JobEvent): Promise<void> {
    await this.publisher.publish(RedisProgressBus.channelName(event.jobId), JSON.stringify(event));
  }

  public async subscribe(jobId: string, listener: (event: JobEvent) => void): Promise<Subscription> {
    const name = RedisProgressBus.channelName(jobId);
    let channel = this.channels.get(name);
    if (channel === undefined) {
      channel = { listeners: new Set(), ready: this.subscriber.subscribe(name) };
      this.channels.set(name, channel);
    }
    channel.listeners.add(listener);
    try {
      await channel.ready;
    } catch (error) {
      await this.release(name, listener);
      throw error;
    }
    return { close: () => this.release(name, listener) };
  }

  private async release(name: string, listener: (event: JobEvent) => void): Promise<void> {
    const channel = this.channels.get(name);
    if (channel === undefined) {
      return;
    }
    channel.listeners.delete(listener);
    if (channel.listeners.size === 0) {
      this.channels.delete(name);
      await this.subscriber.unsubscribe(name);
    }
  }

  private dispatch(name: string, payload: string): void {
    const channel = this.channels.get(name);
    if (channel === undefined) {
      return;
    }
    let event: JobEvent;
    try {
      event = jobEventSchema.parse(JSON.parse(payload));
    } catch (error) {
      this.logger.warn({ channel: name, error }, "dropping malformed job event");
      return;
    }
    for (const listener of channel.listeners) {
      listener(event);
    }
  }

  private static channelName(jobId: string): string {
    return `job-events:${jobId}`;
  }
}
