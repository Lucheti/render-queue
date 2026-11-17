import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Asset } from "../../../src/domain/asset.js";
import { ByteSize } from "../../../src/domain/byte-size.js";
import { ContentType } from "../../../src/domain/content-type.js";
import { Filename } from "../../../src/domain/filename.js";
import { Job } from "../../../src/domain/job.js";
import { collectSse } from "../../support/sse.js";
import { AUTH, buildTestApi, type TestApi } from "../../support/test-api.js";

const JOB_ID = "00000000-0000-4000-8000-0000000000b1";
const ASSET_ID = "00000000-0000-4000-8000-0000000000a1";
const now = new Date("2026-01-01T00:00:00.000Z");
const spec = { kind: "transcode", preset: "h264-720p" } as const;

const collect = collectSse;

describe("GET /jobs/:id/events", () => {
  let api: TestApi;
  let baseUrl: string;

  beforeEach(async () => {
    api = await buildTestApi({ heartbeatMs: 25 });
    await api.app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`;
    await api.assets.insert(
      Asset.requestUpload({
        id: ASSET_ID,
        storageKey: `uploads/${ASSET_ID}`,
        filename: Filename.of("clip.mp4"),
        contentType: ContentType.video("video/mp4"),
        size: ByteSize.of(10),
        now,
      }).markUploaded(ByteSize.of(10), now),
    );
  });

  afterEach(async () => {
    await api.app.close();
  });

  it("streams the current state, live progress and the completion, then closes", async () => {
    await api.jobs.insert(Job.enqueue({ id: JOB_ID, assetId: ASSET_ID, spec, now }).startAttempt(now).reportProgress(20));

    const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/events`, { headers: AUTH });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");

    let published = false;
    const { frames, heartbeats } = await collect(response, async (seen) => {
      if (seen.length === 1 && !published) {
        published = true;
        await api.bus.publish({ type: "progress", jobId: JOB_ID, percent: 55 });
        await api.assets.insert(
          Asset.rendered({
            id: JOB_ID,
            storageKey: `renders/${JOB_ID}/output.mp4`,
            filename: Filename.of("clip-transcode.mp4"),
            contentType: ContentType.of("video/mp4"),
            size: ByteSize.of(99),
            now,
          }),
        );
        const job = await api.jobs.findById(JOB_ID);
        await api.jobs.save(job!.complete(JOB_ID, now));
        await new Promise((resolve) => setTimeout(resolve, 80));
        await api.bus.publish({ type: "completed", jobId: JOB_ID });
      }
    });

    expect(frames.map((f) => f.event)).toEqual(["progress", "progress", "completed"]);
    expect(frames[0]?.data).toEqual({ jobId: JOB_ID, percent: 20 });
    expect(frames[1]?.data).toEqual({ jobId: JOB_ID, percent: 55 });
    expect(frames[2]?.data).toMatchObject({
      id: JOB_ID,
      status: "completed",
      result: { downloadUrl: `https://s3.test/renders/${JOB_ID}/output.mp4?signed=get` },
    });
    expect(heartbeats).toBeGreaterThan(0);
    expect(api.bus.listenerCount(JOB_ID)).toBe(0);
  });

  it("sends the failure and closes", async () => {
    await api.jobs.insert(Job.enqueue({ id: JOB_ID, assetId: ASSET_ID, spec, now }).startAttempt(now));

    const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/events`, { headers: AUTH });
    const { frames } = await collect(response, async (seen) => {
      if (seen.length === 1) {
        await api.bus.publish({ type: "failed", jobId: JOB_ID, error: { code: "invalid_media", message: "bad" } });
      }
    });

    expect(frames.at(-1)).toEqual({
      event: "failed",
      data: { jobId: JOB_ID, error: { code: "invalid_media", message: "bad" } },
    });
    expect(api.bus.listenerCount(JOB_ID)).toBe(0);
  });

  it("replays the terminal state at once for a job that already finished", async () => {
    await api.jobs.insert(
      Job.enqueue({ id: JOB_ID, assetId: ASSET_ID, spec, now }).startAttempt(now).fail({ code: "invalid_media", message: "bad" }, now),
    );

    const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/events`, { headers: AUTH });
    const { frames } = await collect(response);

    expect(frames).toEqual([{ event: "failed", data: { jobId: JOB_ID, error: { code: "invalid_media", message: "bad" } } }]);
  });

  it("releases the subscription when the client disconnects", async () => {
    await api.jobs.insert(Job.enqueue({ id: JOB_ID, assetId: ASSET_ID, spec, now }).startAttempt(now));
    const controller = new AbortController();

    const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/events`, { headers: AUTH, signal: controller.signal });
    await response.body?.getReader().read();
    expect(api.bus.listenerCount(JOB_ID)).toBe(1);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(api.bus.listenerCount(JOB_ID)).toBe(0);
  });

  it("answers a normal 404 problem, not a stream, for an unknown job", async () => {
    const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/events`, { headers: AUTH });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  it("requires the API key", async () => {
    const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/events`);

    expect(response.status).toBe(401);
  });
});
