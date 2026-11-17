import { ConflictError } from "./errors.js";
import { assertValidSpec, type JobSpec } from "./job-spec.js";
import { canTransition, isTerminal, type JobStatus } from "./job-status.js";

/** Why a job failed, in a form safe to show to API clients. */
export interface JobError {
  readonly code: string;
  readonly message: string;
}

/** Plain, persistable state of a Job. */
export interface JobSnapshot {
  readonly id: string;
  readonly assetId: string;
  readonly spec: JobSpec;
  readonly status: JobStatus;
  readonly progress: number;
  readonly attempts: number;
  readonly resultAssetId: string | null;
  readonly error: JobError | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

/** A render job. Every state change goes through a method that checks the transition table. */
export class Job {
  private constructor(private readonly state: JobSnapshot) {}

  /** A new job waiting in the queue. */
  public static enqueue(input: { id: string; assetId: string; spec: JobSpec; now: Date }): Job {
    assertValidSpec(input.spec);
    return new Job({
      id: input.id,
      assetId: input.assetId,
      spec: input.spec,
      status: "queued",
      progress: 0,
      attempts: 0,
      resultAssetId: null,
      error: null,
      createdAt: input.now,
      startedAt: null,
      finishedAt: null,
    });
  }

  /** Rebuilds a Job from persisted state. */
  public static restore(snapshot: JobSnapshot): Job {
    return new Job(snapshot);
  }

  /** Begins an attempt: from `queued`, or again from `running` after a retry or crash. */
  public startAttempt(now: Date): Job {
    this.assertCanMoveTo("running");
    return new Job({
      ...this.state,
      status: "running",
      progress: 0,
      attempts: this.state.attempts + 1,
      startedAt: this.state.startedAt ?? now,
    });
  }

  /** Records progress while running. It never moves backwards and is clamped to 0-100. */
  public reportProgress(percent: number): Job {
    if (this.state.status !== "running") {
      throw new ConflictError("job_not_running", `Job ${this.state.id} is ${this.state.status}, not running.`);
    }
    const clamped = Math.min(100, Math.max(0, Math.floor(percent)));
    return new Job({ ...this.state, progress: Math.max(this.state.progress, clamped) });
  }

  /** Finishes the job with its output asset. */
  public complete(resultAssetId: string, now: Date): Job {
    this.assertCanMoveTo("completed");
    return new Job({ ...this.state, status: "completed", progress: 100, resultAssetId, error: null, finishedAt: now });
  }

  /** Finishes the job as failed. */
  public fail(error: JobError, now: Date): Job {
    this.assertCanMoveTo("failed");
    return new Job({ ...this.state, status: "failed", error, finishedAt: now });
  }

  /** The job's identifier. */
  public get id(): string {
    return this.state.id;
  }

  /** The source asset. */
  public get assetId(): string {
    return this.state.assetId;
  }

  /** What the job does. */
  public get spec(): JobSpec {
    return this.state.spec;
  }

  /** Whether the job can no longer change. */
  public isTerminal(): boolean {
    return isTerminal(this.state.status);
  }

  /** A read-only copy of the state, for persistence and presentation. */
  public snapshot(): JobSnapshot {
    return this.state;
  }

  private assertCanMoveTo(next: JobStatus): void {
    if (!canTransition(this.state.status, next)) {
      throw new ConflictError(
        "invalid_job_transition",
        `Job ${this.state.id} cannot move from ${this.state.status} to ${next}.`,
      );
    }
  }
}
