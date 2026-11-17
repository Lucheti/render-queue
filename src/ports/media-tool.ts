import type { JobSpec } from "../domain/job-spec.js";

/** What probing a file reveals. */
export interface MediaInfo {
  readonly durationSeconds: number;
}

/** One render, fully described. */
export interface MediaOperation {
  readonly spec: JobSpec;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly inputDurationSeconds: number;
}

/** Inspects and renders media. Unreadable input raises a PermanentJobError. */
export interface MediaTool {
  probe(inputPath: string, signal?: AbortSignal): Promise<MediaInfo>;
  /** Runs the operation and reports completion as a percentage (0-100) through `onProgress`. */
  execute(operation: MediaOperation, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<void>;
}
