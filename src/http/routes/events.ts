import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { GetJob } from "../../app/get-job.js";
import type { WatchJob } from "../../app/watch-job.js";
import { assertNever } from "../../domain/assert-never.js";
import { endsStream, type JobEvent } from "../../domain/job-event.js";
import type { Logger } from "../../ports/support.js";
import { problemSchema } from "../problem.js";
import { jobParamsSchema } from "../schemas.js";
import { SseSession, type SseProduction } from "../sse-session.js";
import { serializeJobView } from "./jobs.js";

export interface EventRoutesDependencies {
  readonly watchJob: WatchJob;
  readonly getJob: GetJob;
  readonly heartbeatMs: number;
  readonly logger: Logger;
}

/** `GET /jobs/:id/events`, a server-sent event stream that ends with the job. */
export function eventRoutes(deps: EventRoutesDependencies): FastifyPluginAsyncZod {
  const frameFor = async (event: JobEvent): Promise<SseProduction> => {
    const last = endsStream(event);
    switch (event.type) {
      case "progress":
        return { frame: { event: "progress", data: { jobId: event.jobId, percent: event.percent } }, last };
      case "failed":
        return { frame: { event: "failed", data: { jobId: event.jobId, error: event.error } }, last };
      case "completed":
        try {
          return { frame: { event: "completed", data: serializeJobView(await deps.getJob.execute(event.jobId)) }, last };
        } catch (error) {
          deps.logger.error({ jobId: event.jobId, error }, "could not load the finished job for its event");
          return { frame: { event: "completed", data: { id: event.jobId } }, last };
        }
      default:
        return assertNever(event);
    }
  };

  return async (app) => {
    app.get(
      "/jobs/:id/events",
      {
        schema: {
          tags: ["jobs"],
          summary: "Server-sent events: progress, completed, failed",
          description:
            "Streams `progress`, `completed` and `failed` events, starts with the job's current state, " +
            "sends a heartbeat comment periodically and closes when the job ends. " +
            "Use `fetch` with the `x-api-key` header; `EventSource` cannot set headers.",
          params: jobParamsSchema,
          response: { 404: problemSchema },
        },
      },
      async (request, reply) => {
        let unsubscribe: () => Promise<void> = async () => undefined;
        const session = new SseSession(reply.raw, deps.heartbeatMs, () => unsubscribe());

        const subscription = await deps.watchJob.execute(request.params.id, (event) => {
          session.submit(() => frameFor(event));
        });
        unsubscribe = () => subscription.close();

        request.raw.once("close", () => session.close());
        reply.hijack();
        session.open(reply.getHeaders());
      },
    );
  };
}
