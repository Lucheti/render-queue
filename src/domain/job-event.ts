import type { JobError } from "./job.js";

/** Something that happened to a job; `type` is the discriminant. */
export type JobEvent =
  | { readonly type: "progress"; readonly jobId: string; readonly percent: number }
  | { readonly type: "completed"; readonly jobId: string }
  | { readonly type: "failed"; readonly jobId: string; readonly error: JobError };

/** Whether the event ends the job's stream. */
export function endsStream(event: JobEvent): boolean {
  return event.type !== "progress";
}
