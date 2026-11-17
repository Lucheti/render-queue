import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { CompleteUpload } from "../app/complete-upload.js";
import type { CreateJob } from "../app/create-job.js";
import type { CreateUpload } from "../app/create-upload.js";
import type { GetJob } from "../app/get-job.js";
import type { WatchJob } from "../app/watch-job.js";
import type { Logger } from "../ports/support.js";
import type { ApiKeyAuthenticator } from "./auth.js";
import { PROBLEM_CONTENT_TYPE, ProblemMapper, RateLimitedError, UnauthorizedError } from "./problem.js";
import type { ReadinessProbe } from "./readiness.js";
import { eventRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { jobRoutes } from "./routes/jobs.js";
import { uploadRoutes } from "./routes/uploads.js";

export interface RateLimitSettings {
  readonly max: number;
  readonly windowSeconds: number;
  /** An ioredis client; when set the counters are shared across API instances. */
  readonly redis?: unknown;
}

export interface ServerDependencies {
  readonly logger: FastifyBaseLogger & Logger;
  readonly authenticator: ApiKeyAuthenticator;
  readonly readiness: ReadinessProbe;
  readonly rateLimit: RateLimitSettings;
  readonly corsOrigins: readonly string[];
  readonly sseHeartbeatMs: number;
  readonly createUpload: CreateUpload;
  readonly completeUpload: CompleteUpload;
  readonly createJob: CreateJob;
  readonly getJob: GetJob;
  readonly watchJob: WatchJob;
}

/** Assembles the Fastify application from already-built collaborators. Nothing here opens a connection. */
export async function buildServer(deps: ServerDependencies): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: deps.logger, forceCloseConnections: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const problems = new ProblemMapper();
  app.setErrorHandler((error, request, reply) => {
    const problem = problems.map(error, request.url);
    if (problem.status >= 500) {
      request.log.error({ err: error }, "request failed");
    }
    if (problem.status === 401) {
      void reply.header("www-authenticate", 'ApiKey realm="render-queue"');
    }
    return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problems.notFound(request.url)),
  );

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "render-queue API",
        version: "1.0.0",
        description: "Presigned uploads, render jobs and live progress for browser video tools.",
      },
      components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key" } } },
      security: [{ apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  if (deps.corsOrigins.length > 0) {
    await app.register(cors, { origin: [...deps.corsOrigins], methods: ["GET", "POST", "OPTIONS"] });
  }
  await app.register(rateLimit, {
    global: true,
    max: deps.rateLimit.max,
    timeWindow: deps.rateLimit.windowSeconds * 1000,
    allowList: (request) => request.url.startsWith("/docs"),
    ...(deps.rateLimit.redis === undefined ? {} : { redis: deps.rateLimit.redis }),
    errorResponseBuilder: (_request, context) => new RateLimitedError(context.after),
  });

  await app.register(healthRoutes(deps.readiness));

  await app.register(async (secured) => {
    secured.addHook("onRequest", async (request) => {
      const header = request.headers["x-api-key"];
      if (!deps.authenticator.verify(Array.isArray(header) ? header[0] : header)) {
        throw new UnauthorizedError();
      }
    });
    await secured.register(uploadRoutes(deps));
    await secured.register(jobRoutes(deps));
    await secured.register(
      eventRoutes({
        watchJob: deps.watchJob,
        getJob: deps.getJob,
        heartbeatMs: deps.sseHeartbeatMs,
        logger: deps.logger,
      }),
    );
  });

  return app;
}
