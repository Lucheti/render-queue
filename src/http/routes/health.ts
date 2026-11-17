import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { PROBLEM_CONTENT_TYPE, problemSchema } from "../problem.js";
import type { ReadinessProbe } from "../readiness.js";
import { healthSchema, readinessSchema } from "../schemas.js";

/** `GET /health` (liveness) and `GET /ready` (dependencies reachable). Both are public and not rate limited. */
export function healthRoutes(probe: ReadinessProbe): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      "/health",
      {
        config: { rateLimit: false },
        schema: { tags: ["ops"], summary: "Liveness", security: [], response: { 200: healthSchema } },
      },
      async () => ({ status: "ok" as const }),
    );

    app.get(
      "/ready",
      {
        config: { rateLimit: false },
        schema: {
          tags: ["ops"],
          summary: "Readiness: Postgres, Redis and S3 are reachable",
          security: [],
          response: { 200: readinessSchema, 503: problemSchema },
        },
      },
      async (request, reply) => {
        const report = await probe.run();
        if (report.ready) {
          return { status: "ready" as const, checks: { ...report.checks } };
        }
        return reply
          .code(503)
          .type(PROBLEM_CONTENT_TYPE)
          .send({
            type: "urn:render-queue:problem:not-ready",
            title: "Service Unavailable",
            status: 503,
            detail: "One or more dependencies are unreachable.",
            instance: request.url,
            code: "not_ready",
            checks: report.checks,
          });
      },
    );
  };
}
