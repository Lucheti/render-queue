import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BucketAlreadyOwnedByYou, CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/adapters/drizzle/database.js";
import { openRedis } from "../../src/adapters/redis/redis-connections.js";
import { composeApi, type ApiProcess } from "../../src/composition/api-composition.js";
import { composeWorker, type WorkerProcess } from "../../src/composition/worker-composition.js";
import { loadApiConfig, loadWorkerConfig } from "../../src/config/config.js";
import { collectSse, type SseFrame } from "../support/sse.js";
import { integrationEnv, resetDatabase } from "./support.js";

const run = promisify(execFile);
const API_KEY = "integration-api-key-123456";

interface JobBody {
  id: string;
  status: string;
  progress: number;
  attempts: number;
  error: { code: string; message: string } | null;
  result: { contentType: string; downloadUrl: string; sizeBytes: number } | null;
}

describe("upload -> job -> worker -> SSE, against Postgres, Redis, MinIO and ffmpeg", () => {
  let api: ApiProcess;
  let worker: WorkerProcess;
  let baseUrl: string;
  let scratch: string;
  let sample: Buffer;

  const common = {
    DATABASE_URL: integrationEnv.DATABASE_URL,
    REDIS_URL: integrationEnv.REDIS_URL,
    S3_BUCKET: integrationEnv.S3_BUCKET,
    S3_ENDPOINT: integrationEnv.S3_ENDPOINT,
    S3_PUBLIC_ENDPOINT: integrationEnv.S3_ENDPOINT,
    S3_REGION: integrationEnv.S3_REGION,
    S3_FORCE_PATH_STYLE: integrationEnv.S3_FORCE_PATH_STYLE,
    LOG_LEVEL: "warn",
    JOB_BACKOFF_MS: "50",
  };

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "rq-it-"));

    const s3 = new S3Client({
      region: integrationEnv.S3_REGION,
      endpoint: integrationEnv.S3_ENDPOINT,
      forcePathStyle: true,
    });
    await s3.send(new CreateBucketCommand({ Bucket: integrationEnv.S3_BUCKET })).catch((error: unknown) => {
      if (!(error instanceof BucketAlreadyOwnedByYou) && (error as Error).name !== "BucketAlreadyExists") {
        throw error;
      }
    });
    s3.destroy();

    const database = openDatabase({ connectionString: integrationEnv.DATABASE_URL, ssl: false, poolSize: 1 });
    await resetDatabase(database.db, database.pool);
    await database.pool.end();
    const redis = openRedis(integrationEnv.REDIS_URL, { blocking: false });
    await redis.flushdb();
    redis.disconnect();

    const samplePath = join(scratch, "sample.mp4");
    await run("ffmpeg", [
      ...["-hide_banner", "-loglevel", "error", "-y"],
      ...["-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=15"],
      ...["-f", "lavfi", "-i", "sine=frequency=440:duration=4"],
      ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", samplePath],
    ]);
    sample = await readFile(samplePath);

    api = await composeApi(loadApiConfig({ ...common, API_KEY }));
    await api.server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(api.server.server.address() as AddressInfo).port}`;

    worker = composeWorker(loadWorkerConfig({ ...common, WORK_DIR: scratch, PROGRESS_RECORD_INTERVAL_MS: "0" }));
    worker.start();
  });

  afterAll(async () => {
    await worker.shutdown();
    await api.shutdown();
    await rm(scratch, { recursive: true, force: true });
  });

  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { "x-api-key": API_KEY, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function upload(bytes: Buffer, contentType = "video/mp4"): Promise<string> {
    const created = await call("POST", "/uploads", { filename: "sample.mp4", contentType, size: bytes.length });
    expect(created.status).toBe(201);
    const { assetId, uploadUrl, headers } = (await created.json()) as {
      assetId: string;
      uploadUrl: string;
      headers: Record<string, string>;
    };

    const put = await fetch(uploadUrl, { method: "PUT", headers, body: new Uint8Array(bytes) });
    expect(put.status).toBe(200);

    const completed = await call("POST", `/uploads/${assetId}/complete`);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ status: "uploaded", sizeBytes: bytes.length });
    return assetId;
  }

  async function render(assetId: string, kind: string, params: unknown): Promise<{ frames: SseFrame[]; job: JobBody }> {
    const created = await call("POST", "/jobs", { assetId, kind, params });
    expect(created.status).toBe(202);
    const { jobId } = (await created.json()) as { jobId: string };

    const events = await fetch(`${baseUrl}/jobs/${jobId}/events`, { headers: { "x-api-key": API_KEY } });
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const { frames } = await collectSse(events);

    const job = (await (await call("GET", `/jobs/${jobId}`)).json()) as JobBody;
    return { frames, job };
  }

  async function probe(url: string, name: string): Promise<{ height: number; duration: number }> {
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
    const path = join(scratch, name);
    await writeFile(path, bytes);
    const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
    const parsed = JSON.parse(stdout) as { streams: Array<{ codec_type: string; height?: number }>; format: { duration: string } };
    return {
      height: parsed.streams.find((s) => s.codec_type === "video")?.height ?? 0,
      duration: Number(parsed.format.duration),
    };
  }

  it("transcodes to 480p, streaming progress up to completion", async () => {
    const assetId = await upload(sample);

    const { frames, job } = await render(assetId, "transcode", { preset: "h264-480p" });

    const events = frames.map((frame) => frame.event);
    expect(events.at(-1)).toBe("completed");
    expect(events.filter((event) => event === "progress").length).toBeGreaterThan(0);
    expect(job).toMatchObject({ status: "completed", progress: 100, attempts: 1, error: null });
    expect(job.result?.contentType).toBe("video/mp4");
    expect((await probe(job.result?.downloadUrl ?? "", "transcoded.mp4")).height).toBe(480);
  });

  it("extracts a JPEG thumbnail", async () => {
    const assetId = await upload(sample);

    const { job } = await render(assetId, "thumbnail", { time: 1.5 });

    expect(job.status).toBe("completed");
    expect(job.result?.contentType).toBe("image/jpeg");
    const bytes = Buffer.from(await (await fetch(job.result?.downloadUrl ?? "")).arrayBuffer());
    expect(bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
  });

  it("trims to the requested span", async () => {
    const assetId = await upload(sample);

    const { job } = await render(assetId, "trim", { start: 1, end: 3 });

    expect(job.status).toBe("completed");
    const { duration } = await probe(job.result?.downloadUrl ?? "", "trimmed.mp4");
    expect(duration).toBeGreaterThan(1.7);
    expect(duration).toBeLessThan(2.4);
  });

  it("fails a job whose source is not media, once, with a clear error", async () => {
    const assetId = await upload(Buffer.from("this is definitely not a video".repeat(20)));

    const { frames, job } = await render(assetId, "transcode", { preset: "h264-720p" });

    expect(frames.at(-1)).toMatchObject({ event: "failed", data: { error: { code: "invalid_media" } } });
    expect(job).toMatchObject({ status: "failed", attempts: 1, error: { code: "invalid_media" }, result: null });
  });

  it("fails a thumbnail requested past the end of the video", async () => {
    const assetId = await upload(sample);

    const { job } = await render(assetId, "thumbnail", { time: 60 });

    expect(job).toMatchObject({ status: "failed", attempts: 1, error: { code: "time_out_of_range" } });
  });

  it("refuses a PUT whose content type or length differs from what was signed", async () => {
    const created = await call("POST", "/uploads", { filename: "a.mp4", contentType: "video/mp4", size: sample.length });
    const { uploadUrl } = (await created.json()) as { uploadUrl: string };

    const wrongType = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "video/webm" }, body: new Uint8Array(sample) });
    const wrongLength = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "video/mp4" },
      body: new Uint8Array(Buffer.concat([sample, Buffer.from("extra")])),
    });

    expect(wrongType.status).toBe(403);
    expect(wrongLength.status).toBe(403);
  });

  it("answers 409 when completing an upload that never happened", async () => {
    const created = await call("POST", "/uploads", { filename: "a.mp4", contentType: "video/mp4", size: 100 });
    const { assetId } = (await created.json()) as { assetId: string };

    const response = await call("POST", `/uploads/${assetId}/complete`);

    expect(response.status).toBe(409);
  });

  it("reports readiness with all three dependencies", async () => {
    const response = await fetch(`${baseUrl}/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", checks: { postgres: "ok", redis: "ok", s3: "ok" } });
  });
});
