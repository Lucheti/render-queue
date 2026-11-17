export interface SseFrame {
  readonly event: string;
  readonly data: unknown;
}

export interface SseCapture {
  readonly frames: SseFrame[];
  readonly heartbeats: number;
}

/** Reads a server-sent event response until the server closes it, collecting frames and heartbeat comments. */
export async function collectSse(
  response: Response,
  onFrame?: (frames: SseFrame[]) => Promise<void> | void,
): Promise<SseCapture> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) {
    throw new Error("response has no body");
  }
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let heartbeats = 0;
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (block.startsWith(": heartbeat")) {
        heartbeats += 1;
      } else if (block.startsWith("event:")) {
        const [eventLine = "", dataLine = ""] = block.split("\n");
        frames.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
        await onFrame?.(frames);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  return { frames, heartbeats };
}
