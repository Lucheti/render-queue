export const JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * The only place that knows which status changes are legal:
 * queued -> running -> completed | failed.
 * `running -> running` is a fresh attempt after a retry or a worker crash.
 */
const ALLOWED: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["running"],
  running: ["running", "completed", "failed"],
  completed: [],
  failed: [],
};

/** Whether a job may move from `from` to `to`. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** Whether no further transition is possible. */
export function isTerminal(status: JobStatus): boolean {
  return ALLOWED[status].length === 0;
}
