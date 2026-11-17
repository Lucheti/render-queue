import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_KEY, AUTH, buildTestApi, type TestApi } from "../../support/test-api.js";

const PROBLEM = /^application\/problem\+json/;

describe("API", () => {
  let api: TestApi;

  beforeEach(async () => {
    api = await buildTestApi();
  });

  afterEach(async () => {
    await api.app.close();
  });

  async function uploadedAssetId(): Promise<string> {
    const created = await api.app.inject({
      method: "POST",
      url: "/uploads",
      headers: AUTH,
      payload: { filename: "clip.mp4", contentType: "video/mp4", size: 5_000 },
    });
    const { assetId } = created.json<{ assetId: string }>();
    api.store.objects.set(`uploads/${assetId}`, { sizeBytes: 5_000 });
    await api.app.inject({ method: "POST", url: `/uploads/${assetId}/complete`, headers: AUTH });
    return assetId;
  }

  describe("authentication", () => {
    it("rejects a missing key with a 401 problem", async () => {
      const response = await api.app.inject({ method: "GET", url: "/jobs/00000000-0000-4000-8000-000000000099" });

      expect(response.statusCode).toBe(401);
      expect(response.headers["content-type"]).toMatch(PROBLEM);
      expect(response.headers["www-authenticate"]).toContain("ApiKey");
      expect(response.json()).toMatchObject({
        type: "urn:render-queue:problem:unauthorized",
        title: "Unauthorized",
        status: 401,
        code: "unauthorized",
        instance: "/jobs/00000000-0000-4000-8000-000000000099",
      });
    });

    it("rejects a wrong key, including one that shares a prefix with the real key", async () => {
      for (const key of ["nope", API_KEY.slice(0, -1), `${API_KEY}x`, ""]) {
        const response = await api.app.inject({ method: "POST", url: "/uploads", headers: { "x-api-key": key } });
        expect(response.statusCode, key).toBe(401);
      }
    });

    it("leaves liveness, readiness and docs open", async () => {
      expect((await api.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect((await api.app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
      expect((await api.app.inject({ method: "GET", url: "/docs/json" })).statusCode).toBe(200);
    });
  });

  describe("health", () => {
    it("reports liveness", async () => {
      const response = await api.app.inject({ method: "GET", url: "/health" });

      expect(response.json()).toEqual({ status: "ok" });
    });

    it("reports every dependency when ready", async () => {
      const response = await api.app.inject({ method: "GET", url: "/ready" });

      expect(response.json()).toEqual({ status: "ready", checks: { postgres: "ok", redis: "ok", s3: "ok" } });
    });

    it("answers 503 problem+json naming the failed dependency", async () => {
      api.checks.redis = false;

      const response = await api.app.inject({ method: "GET", url: "/ready" });

      expect(response.statusCode).toBe(503);
      expect(response.headers["content-type"]).toMatch(PROBLEM);
      expect(response.json()).toMatchObject({
        status: 503,
        code: "not_ready",
        checks: { postgres: "ok", redis: "failed", s3: "ok" },
      });
    });
  });

  describe("POST /uploads", () => {
    it("returns the asset id and a presigned URL", async () => {
      const response = await api.app.inject({
        method: "POST",
        url: "/uploads",
        headers: AUTH,
        payload: { filename: "clip.mp4", contentType: "video/mp4", size: 5_000 },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json<{ assetId: string; uploadUrl: string; headers: Record<string, string>; expiresAt: string }>();
      expect(body.uploadUrl).toBe(`https://s3.test/uploads/${body.assetId}?signed=put`);
      expect(body.headers).toEqual({ "Content-Type": "video/mp4" });
      expect(body.expiresAt).toBe("2026-01-01T00:15:00.000Z");
    });

    it("rejects non-video types as 422 problem+json", async () => {
      const response = await api.app.inject({
        method: "POST",
        url: "/uploads",
        headers: AUTH,
        payload: { filename: "a.png", contentType: "image/png", size: 10 },
      });

      expect(response.statusCode).toBe(422);
      expect(response.headers["content-type"]).toMatch(PROBLEM);
      expect(response.json()).toMatchObject({
        type: "urn:render-queue:problem:unsupported-content-type",
        status: 422,
        code: "unsupported_content_type",
      });
    });

    it("rejects an oversized file as 422", async () => {
      const response = await api.app.inject({
        method: "POST",
        url: "/uploads",
        headers: AUTH,
        payload: { filename: "big.mp4", contentType: "video/mp4", size: 5_000_000 },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "size_limit_exceeded" });
    });

    it("rejects a malformed body as 400 with field pointers", async () => {
      const response = await api.app.inject({
        method: "POST",
        url: "/uploads",
        headers: AUTH,
        payload: { filename: "a.mp4", contentType: "video/mp4", size: "big" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"]).toMatch(PROBLEM);
      const problem = response.json<{ code: string; errors: Array<{ in: string; pointer: string }> }>();
      expect(problem.code).toBe("validation_failed");
      expect(problem.errors).toEqual([expect.objectContaining({ in: "body", pointer: "/size" })]);
    });

    it("rejects invalid JSON as a 400 problem", async () => {
      const response = await api.app.inject({
        method: "POST",
        url: "/uploads",
        headers: { ...AUTH, "content-type": "application/json" },
        payload: "{not json",
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"]).toMatch(PROBLEM);
    });
  });

  describe("POST /uploads/:assetId/complete", () => {
    it("marks the asset uploaded", async () => {
      const assetId = await uploadedAssetId();

      const response = await api.app.inject({ method: "POST", url: `/uploads/${assetId}/complete`, headers: AUTH });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ assetId, status: "uploaded", filename: "clip.mp4", contentType: "video/mp4", sizeBytes: 5_000 });
    });

    it("answers 409 before the object exists", async () => {
      const created = await api.app.inject({
        method: "POST",
        url: "/uploads",
        headers: AUTH,
        payload: { filename: "clip.mp4", contentType: "video/mp4", size: 5_000 },
      });
      const { assetId } = created.json<{ assetId: string }>();

      const response = await api.app.inject({ method: "POST", url: `/uploads/${assetId}/complete`, headers: AUTH });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "upload_missing" });
    });

    it("answers 404 for an unknown asset and 400 for a malformed id", async () => {
      const unknown = await api.app.inject({
        method: "POST",
        url: "/uploads/00000000-0000-4000-8000-0000000000aa/complete",
        headers: AUTH,
      });
      const malformed = await api.app.inject({ method: "POST", url: "/uploads/not-a-uuid/complete", headers: AUTH });

      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ code: "asset_not_found" });
      expect(malformed.statusCode).toBe(400);
    });
  });

  describe("POST /jobs and GET /jobs/:id", () => {
    it("enqueues a job and exposes it", async () => {
      const assetId = await uploadedAssetId();

      const created = await api.app.inject({
        method: "POST",
        url: "/jobs",
        headers: AUTH,
        payload: { assetId, kind: "trim", params: { start: 1, end: 4 } },
      });

      expect(created.statusCode).toBe(202);
      const { jobId } = created.json<{ jobId: string }>();
      expect(created.headers["location"]).toBe(`/jobs/${jobId}`);
      expect(api.queue.enqueued).toEqual([jobId]);

      const fetched = await api.app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: AUTH });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json()).toMatchObject({
        id: jobId,
        assetId,
        kind: "trim",
        status: "queued",
        progress: 0,
        result: null,
        error: null,
        startedAt: null,
      });
    });

    it.each([
      ["thumbnail", { time: 3 }],
      ["transcode", { preset: "h264-480p" }],
    ])("accepts a %s job", async (kind, params) => {
      const assetId = await uploadedAssetId();

      const response = await api.app.inject({ method: "POST", url: "/jobs", headers: AUTH, payload: { assetId, kind, params } });

      expect(response.statusCode).toBe(202);
    });

    it.each([
      ["an unknown kind", { kind: "gif", params: {} }],
      ["params of another kind", { kind: "transcode", params: { time: 3 } }],
      ["an unknown preset", { kind: "transcode", params: { preset: "h264-4k" } }],
      ["a negative time", { kind: "thumbnail", params: { time: -1 } }],
    ])("rejects %s with 400", async (_name, rest) => {
      const assetId = await uploadedAssetId();

      const response = await api.app.inject({ method: "POST", url: "/jobs", headers: AUTH, payload: { assetId, ...rest } });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "validation_failed" });
    });

    it("rejects a trim whose end is not after its start with 422", async () => {
      const assetId = await uploadedAssetId();

      const response = await api.app.inject({
        method: "POST",
        url: "/jobs",
        headers: AUTH,
        payload: { assetId, kind: "trim", params: { start: 5, end: 5 } },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "invalid_range" });
    });

    it("answers 409 for an asset that is not uploaded and 404 for an unknown one", async () => {
      const created = await api.app.inject({
        method: "POST",
        url: "/uploads",
        headers: AUTH,
        payload: { filename: "clip.mp4", contentType: "video/mp4", size: 5_000 },
      });
      const { assetId } = created.json<{ assetId: string }>();

      const pending = await api.app.inject({
        method: "POST",
        url: "/jobs",
        headers: AUTH,
        payload: { assetId, kind: "thumbnail", params: { time: 1 } },
      });
      const unknown = await api.app.inject({
        method: "POST",
        url: "/jobs",
        headers: AUTH,
        payload: { assetId: "00000000-0000-4000-8000-0000000000aa", kind: "thumbnail", params: { time: 1 } },
      });

      expect(pending.statusCode).toBe(409);
      expect(unknown.statusCode).toBe(404);
    });

    it("answers 503 when the queue is down, and leaves no orphan job", async () => {
      const assetId = await uploadedAssetId();
      api.queue.failWith = new Error("redis down");

      const response = await api.app.inject({
        method: "POST",
        url: "/jobs",
        headers: AUTH,
        payload: { assetId, kind: "thumbnail", params: { time: 1 } },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "queue_unavailable" });
      expect(api.jobs.rows.size).toBe(0);
    });

    it("answers 404 problem for an unknown job", async () => {
      const response = await api.app.inject({
        method: "GET",
        url: "/jobs/00000000-0000-4000-8000-0000000000aa",
        headers: AUTH,
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toMatch(PROBLEM);
      expect(response.json()).toMatchObject({ code: "job_not_found" });
    });
  });

  describe("unknown routes", () => {
    it("answer with a 404 problem", async () => {
      const response = await api.app.inject({ method: "GET", url: "/nope", headers: AUTH });

      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toMatch(PROBLEM);
      expect(response.json()).toMatchObject({ code: "route_not_found", instance: "/nope" });
    });
  });

  describe("OpenAPI", () => {
    it("documents every endpoint and the API key scheme", async () => {
      const response = await api.app.inject({ method: "GET", url: "/docs/json" });
      const spec = response.json<{ openapi: string; paths: Record<string, unknown>; components: { securitySchemes: unknown } }>();

      expect(Object.keys(spec.paths).sort()).toEqual(
        ["/health", "/jobs", "/jobs/{id}", "/jobs/{id}/events", "/ready", "/uploads", "/uploads/{assetId}/complete"].sort(),
      );
      expect(spec.components.securitySchemes).toMatchObject({ apiKey: { type: "apiKey", in: "header", name: "x-api-key" } });
    });

    it("serves the interactive docs page", async () => {
      const response = await api.app.inject({ method: "GET", url: "/docs" });

      expect([200, 302]).toContain(response.statusCode);
    });
  });

});

describe("rate limiting", () => {
  it("answers 429 problem+json once the window is exhausted, but never for health checks", async () => {
    const api = await buildTestApi({ rateLimitMax: 2 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        statuses.push((await api.app.inject({ method: "GET", url: "/jobs/00000000-0000-4000-8000-0000000000aa", headers: AUTH })).statusCode);
      }
      const limited = await api.app.inject({ method: "GET", url: "/jobs/00000000-0000-4000-8000-0000000000aa", headers: AUTH });

      expect(statuses).toEqual([404, 404, 429]);
      expect(limited.headers["content-type"]).toMatch(PROBLEM);
      expect(limited.headers["retry-after"]).toBeDefined();
      expect(limited.json()).toMatchObject({ status: 429, code: "rate_limited" });
      expect((await api.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      await api.app.close();
    }
  });
});
