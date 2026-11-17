/** Hands job identifiers to the workers. */
export interface JobQueue {
  /** Adds the job to the queue. Enqueuing the same id twice must not create two runs. */
  enqueue(jobId: string): Promise<void>;
}
