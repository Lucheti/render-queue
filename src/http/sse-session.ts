import type { ServerResponse } from "node:http";

/** One server-sent event. */
export interface SseFrame {
  readonly event: string;
  readonly data: unknown;
}

/** What a producer yields for a queued event: the frame, and whether it is the last one. */
export interface SseProduction {
  readonly frame: SseFrame;
  readonly last: boolean;
}

/**
 * Owns one open event stream: writes frames in the order they were submitted (even when producing a frame is
 * asynchronous), sends heartbeats so proxies keep the connection, and closes itself after the last frame.
 * Frames submitted before `open()` are held back, so a handler can still fail with a normal error response.
 */
export class SseSession {
  private opened = false;
  private ended = false;
  private lastQueued = false;
  private held: string[] = [];
  private tail: Promise<void> = Promise.resolve();
  private heartbeat: NodeJS.Timeout | null = null;

  public constructor(
    private readonly response: ServerResponse,
    private readonly heartbeatMs: number,
    private readonly onEnd: () => Promise<void>,
  ) {}

  /** Queues a frame; its producer runs after every earlier one has been written. */
  public submit(produce: () => Promise<SseProduction>): void {
    this.tail = this.tail.then(async () => {
      if (this.ended) {
        return;
      }
      const { frame, last } = await produce();
      this.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
      if (last) {
        this.lastQueued = true;
        this.finishIfDone();
      }
    });
  }

  /** Writes the response head and starts the heartbeat. */
  public open(headers: Readonly<Record<string, string | number | string[] | undefined>>): void {
    this.response.writeHead(200, {
      ...headers,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    this.opened = true;
    this.response.write("retry: 3000\n\n");
    for (const chunk of this.held) {
      this.response.write(chunk);
    }
    this.held = [];
    this.heartbeat = setInterval(() => this.response.write(": heartbeat\n\n"), this.heartbeatMs);
    this.finishIfDone();
  }

  /** Ends the stream, from either side. Safe to call more than once. */
  public close(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
    }
    if (!this.response.writableEnded) {
      this.response.end();
    }
    void this.onEnd();
  }

  private write(chunk: string): void {
    if (this.ended) {
      return;
    }
    if (this.opened) {
      this.response.write(chunk);
    } else {
      this.held.push(chunk);
    }
  }

  private finishIfDone(): void {
    if (this.lastQueued && this.opened) {
      this.close();
    }
  }
}
