/** Name of the BullMQ queue shared by the API (producer) and the worker (consumer). */
export const RENDER_QUEUE = "render-jobs";

/** Name given to every job added to the queue. */
export const RENDER_JOB_NAME = "render";

/** What travels through Redis: only the id. The job's details live in Postgres. */
export interface RenderJobPayload {
  readonly jobId: string;
}

/** How failed jobs are retried. */
export interface RetryPolicy {
  readonly attempts: number;
  readonly backoffMs: number;
}
