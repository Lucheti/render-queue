import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { CreateJob } from "../../app/create-job.js";
import type { GetJob, JobView } from "../../app/get-job.js";
import { problemSchema } from "../problem.js";
import {
  createJobRequestSchema,
  createJobResponseSchema,
  jobParamsSchema,
  jobViewSchema,
  toCreateJobCommand,
} from "../schemas.js";

export interface JobRoutesDependencies {
  readonly createJob: CreateJob;
  readonly getJob: GetJob;
}

/** Converts a JobView into its JSON representation. */
export function serializeJobView(view: JobView): ReturnType<typeof jobViewSchema.parse> {
  return {
    id: view.id,
    assetId: view.assetId,
    kind: view.kind,
    status: view.status,
    progress: view.progress,
    attempts: view.attempts,
    createdAt: view.createdAt.toISOString(),
    startedAt: view.startedAt?.toISOString() ?? null,
    finishedAt: view.finishedAt?.toISOString() ?? null,
    result:
      view.result === null
        ? null
        : {
            assetId: view.result.assetId,
            filename: view.result.filename,
            contentType: view.result.contentType,
            sizeBytes: view.result.sizeBytes,
            downloadUrl: view.result.downloadUrl,
            expiresAt: view.result.expiresAt.toISOString(),
          },
    error: view.error,
  };
}

/** `POST /jobs` and `GET /jobs/:id`. */
export function jobRoutes(deps: JobRoutesDependencies): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/jobs",
      {
        schema: {
          tags: ["jobs"],
          summary: "Enqueue a render job for an uploaded asset",
          body: createJobRequestSchema,
          response: {
            202: createJobResponseSchema,
            400: problemSchema,
            404: problemSchema,
            409: problemSchema,
            422: problemSchema,
            503: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const jobId = await deps.createJob.execute(toCreateJobCommand(request.body));
        return reply.code(202).header("location", `/jobs/${jobId}`).send({ jobId });
      },
    );

    app.get(
      "/jobs/:id",
      {
        schema: {
          tags: ["jobs"],
          summary: "Job status, progress, and the result when finished",
          params: jobParamsSchema,
          response: { 200: jobViewSchema, 404: problemSchema },
        },
      },
      async (request) => serializeJobView(await deps.getJob.execute(request.params.id)),
    );
  };
}
