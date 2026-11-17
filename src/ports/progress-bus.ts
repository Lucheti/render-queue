import type { JobEvent } from "../domain/job-event.js";

/** A live subscription that can be cancelled. */
export interface Subscription {
  close(): Promise<void>;
}

/** Fan-out of job events from workers to API instances. */
export interface ProgressBus {
  publish(event: JobEvent): Promise<void>;
  subscribe(jobId: string, listener: (event: JobEvent) => void): Promise<Subscription>;
}
