import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3ObjectStore } from "../../../src/adapters/s3/s3-object-store.js";
import { createS3Clients } from "../../../src/adapters/s3/s3-clients.js";
import { ConfigError, loadApiConfig, loadMigrateConfig, loadWorkerConfig } from "../../../src/config/config.js";
import { ApiKeyAuthenticator } from "../../../src/http/auth.js";
import { ReadinessProbe } from "../../../src/http/readiness.js";

describe("S3ObjectStore presigning", () => {
  const credentials = { accessKeyId: "AKIATEST", secretAccessKey: "secret" };
  const { client, presignClient } = (() => {
    const clients = createS3Clients({
      region: "us-east-1",
      endpoint: "http://minio:9000",
      publicEndpoint: "http://localhost:9000",
      forcePathStyle: true,
    });
    return clients;
  })();
  const store = new S3ObjectStore({
    bucket: "media",
    client: new S3Client({ region: "us-east-1", credentials, endpoint: "http://minio:9000", forcePathStyle: true }),
    presignClient: new S3Client({
      region: "us-east-1",
      credentials,
      endpoint: "http://localhost:9000",
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
    }),
  });

  it("builds a pair of clients, reusing one when the public endpoint is the same", () => {
    expect(client).not.toBe(presignClient);
    const same = createS3Clients({ region: "us-east-1", endpoint: undefined, publicEndpoint: undefined, forcePathStyle: false });
    expect(same.client).toBe(same.presignClient);
  });

  it("signs an upload URL for the public endpoint, binding content type and length", async () => {
    const url = new URL(await store.presignUpload({ key: "uploads/abc", contentType: "video/mp4", sizeBytes: 1234, expiresInSeconds: 600 }));

    expect(url.origin).toBe("http://localhost:9000");
    expect(url.pathname).toBe("/media/uploads/abc");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(url.searchParams.has("x-amz-checksum-crc32")).toBe(false);
  });

  it("signs a download URL that forces a download with the original name", async () => {
    const url = new URL(await store.presignDownload({ key: "renders/j/output.mp4", filename: "my clip.mp4", expiresInSeconds: 60 }));

    expect(url.searchParams.get("response-content-disposition")).toBe("attachment; filename*=UTF-8''my%20clip.mp4");
  });
});

describe("ApiKeyAuthenticator", () => {
  const authenticator = new ApiKeyAuthenticator("correct-horse-battery");

  it("accepts only the exact key", () => {
    expect(authenticator.verify("correct-horse-battery")).toBe(true);
    expect(authenticator.verify("correct-horse-batter")).toBe(false);
    expect(authenticator.verify("correct-horse-battery ")).toBe(false);
    expect(authenticator.verify("")).toBe(false);
    expect(authenticator.verify(undefined)).toBe(false);
  });

  it("does not accept an empty header even when the configured key is empty", () => {
    expect(new ApiKeyAuthenticator("").verify(undefined)).toBe(false);
  });
});

describe("ReadinessProbe", () => {
  it("fails a dependency that throws and one that hangs past the deadline", async () => {
    const probe = new ReadinessProbe(
      [
        { name: "up", check: async () => undefined },
        { name: "broken", check: async () => Promise.reject(new Error("boom")) },
        { name: "hung", check: () => new Promise<void>(() => undefined) },
      ],
      30,
    );

    expect(await probe.run()).toEqual({ ready: false, checks: { up: "ok", broken: "failed", hung: "failed" } });
  });

  it("is ready when every dependency answers", async () => {
    const probe = new ReadinessProbe([{ name: "up", check: async () => undefined }], 30);

    expect(await probe.run()).toEqual({ ready: true, checks: { up: "ok" } });
  });
});

describe("configuration", () => {
  const base = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    REDIS_URL: "redis://localhost:6379",
    S3_BUCKET: "media",
  };

  it("loads the API config with defaults", () => {
    const config = loadApiConfig({ ...base, API_KEY: "0123456789abcdef", CORS_ORIGINS: "http://a.test, http://b.test ," });

    expect(config).toMatchObject({
      port: 3000,
      host: "0.0.0.0",
      maxUploadBytes: 2 * 1024 ** 3,
      corsOrigins: ["http://a.test", "http://b.test"],
      database: { url: base.DATABASE_URL, ssl: false },
      s3: { bucket: "media", region: "us-east-1", forcePathStyle: false, endpoint: undefined },
      queue: { attempts: 3, backoffMs: 5000 },
    });
  });

  it("requires a long enough API key and lists every problem at once", () => {
    const failure = (() => {
      try {
        loadApiConfig({ API_KEY: "short" });
      } catch (error) {
        return error;
      }
      return null;
    })();

    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as Error).message).toContain("API_KEY: must be at least 16 characters");
    expect((failure as Error).message).toContain("REDIS_URL");
    expect((failure as Error).message).toContain("S3_BUCKET");
  });

  it("builds the database URL from parts, escaping the password", () => {
    const config = loadWorkerConfig({
      REDIS_URL: base.REDIS_URL,
      S3_BUCKET: base.S3_BUCKET,
      DB_HOST: "db.internal",
      DB_NAME: "render",
      DB_USER: "render",
      DB_PASSWORD: "p@ss/word:1",
      DATABASE_SSL: "require",
    });

    expect(config.database).toMatchObject({ url: "postgres://render:p%40ss%2Fword%3A1@db.internal:5432/render", ssl: true });
    expect(config).toMatchObject({ concurrency: 2, ffmpegPath: "ffmpeg", shutdownGraceMs: 100_000 });
  });

  it("refuses to start without any database settings", () => {
    expect(() => loadMigrateConfig({})).toThrow(ConfigError);
  });

  it("parses booleans for path-style addressing", () => {
    const config = loadWorkerConfig({ ...base, S3_FORCE_PATH_STYLE: "true", S3_ENDPOINT: "http://minio:9000" });

    expect(config.s3).toMatchObject({ forcePathStyle: true, endpoint: "http://minio:9000" });
  });
});
