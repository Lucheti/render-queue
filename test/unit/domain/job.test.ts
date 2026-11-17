import { describe, expect, it } from "vitest";
import { ConflictError } from "../../../src/domain/errors.js";
import { Job } from "../../../src/domain/job.js";
import { canTransition, isTerminal, JOB_STATUSES, type JobStatus } from "../../../src/domain/job-status.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");
const t1 = new Date("2026-01-01T00:00:10.000Z");

const queued = (): Job =>
  Job.enqueue({ id: "job-1", assetId: "asset-1", spec: { kind: "transcode", preset: "h264-720p" }, now: t0 });

describe("job status rules", () => {
  const legal: Array<[JobStatus, JobStatus]> = [
    ["queued", "running"],
    ["running", "running"],
    ["running", "completed"],
    ["running", "failed"],
  ];

  it("allows exactly the documented transitions", () => {
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        const expected = legal.some(([a, b]) => a === from && b === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("treats completed and failed as terminal", () => {
    expect(JOB_STATUSES.filter(isTerminal)).toEqual(["completed", "failed"]);
  });
});

describe("Job", () => {
  it("starts queued with no progress", () => {
    expect(queued().snapshot()).toMatchObject({ status: "queued", progress: 0, attempts: 0, resultAssetId: null });
  });

  it("refuses an invalid spec at birth", () => {
    expect(() =>
      Job.enqueue({ id: "j", assetId: "a", spec: { kind: "trim", start: 10, end: 5 }, now: t0 }),
    ).toThrowError(expect.objectContaining({ code: "invalid_range" }));
  });

  it("runs, reports monotonic clamped progress, and completes", () => {
    const running = queued().startAttempt(t0);
    expect(running.snapshot()).toMatchObject({ status: "running", attempts: 1, startedAt: t0 });

    const halfway = running.reportProgress(50.9);
    expect(halfway.snapshot().progress).toBe(50);
    expect(halfway.reportProgress(20).snapshot().progress).toBe(50);
    expect(halfway.reportProgress(400).snapshot().progress).toBe(100);

    const done = halfway.complete("asset-2", t1);
    expect(done.snapshot()).toMatchObject({ status: "completed", progress: 100, resultAssetId: "asset-2", finishedAt: t1 });
    expect(done.isTerminal()).toBe(true);
  });

  it("starts a fresh attempt from running, resetting progress and keeping the first start time", () => {
    const first = queued().startAttempt(t0).reportProgress(70);
    const second = first.startAttempt(t1);
    expect(second.snapshot()).toMatchObject({ status: "running", attempts: 2, progress: 0, startedAt: t0 });
  });

  it("fails with an error from running", () => {
    const failed = queued().startAttempt(t0).fail({ code: "invalid_media", message: "bad" }, t1);
    expect(failed.snapshot()).toMatchObject({ status: "failed", error: { code: "invalid_media", message: "bad" }, finishedAt: t1 });
  });

  it("cannot complete or fail straight from queued", () => {
    expect(() => queued().complete("a", t1)).toThrowError(expect.objectContaining({ code: "invalid_job_transition" }));
    expect(() => queued().fail({ code: "x", message: "y" }, t1)).toThrow(ConflictError);
  });

  it("cannot move once terminal", () => {
    const done = queued().startAttempt(t0).complete("a", t1);
    expect(() => done.startAttempt(t1)).toThrow(ConflictError);
    expect(() => done.fail({ code: "x", message: "y" }, t1)).toThrow(ConflictError);
    const failed = queued().startAttempt(t0).fail({ code: "x", message: "y" }, t1);
    expect(() => failed.complete("a", t1)).toThrow(ConflictError);
  });

  it("only accepts progress while running", () => {
    expect(() => queued().reportProgress(10)).toThrowError(expect.objectContaining({ code: "job_not_running" }));
  });
});
