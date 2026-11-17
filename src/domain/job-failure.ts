/** A failure that retrying cannot fix (bad input, missing source, unreadable media). */
export class PermanentJobError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentJobError";
    this.code = code;
  }
}

/** A failure worth retrying (network, storage or process hiccups). */
export class TransientJobError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransientJobError";
    this.code = code;
  }
}

/** The worker is shutting down and asked the running job to stop. It is not a failure. */
export class JobAbortedError extends Error {
  public constructor() {
    super("Job aborted because the worker is shutting down.");
    this.name = "JobAbortedError";
  }
}
