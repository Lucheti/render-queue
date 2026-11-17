import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset } from "../../src/domain/asset.js";
import type { JobEvent } from "../../src/domain/job-event.js";
import type { Job } from "../../src/domain/job.js";
import type { MediaInfo, MediaOperation, MediaTool } from "../../src/ports/media-tool.js";
import type { ObjectStore, StoredObject } from "../../src/ports/object-store.js";
import type { ProgressBus, Subscription } from "../../src/ports/progress-bus.js";
import type { JobQueue } from "../../src/ports/job-queue.js";
import type { AssetRepository, JobRepository } from "../../src/ports/repositories.js";
import type { Clock, IdGenerator, Logger, Workspace, WorkspaceProvider } from "../../src/ports/support.js";

export class FixedClock implements Clock {
  public constructor(private current = new Date("2026-01-01T00:00:00.000Z")) {}

  public now(): Date {
    return this.current;
  }

  public advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds implements IdGenerator {
  private counter = 0;

  public next(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`;
  }
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class InMemoryAssetRepository implements AssetRepository {
  public readonly rows = new Map<string, Asset>();

  public async insert(asset: Asset): Promise<void> {
    this.rows.set(asset.id, asset);
  }

  public async findById(id: string): Promise<Asset | null> {
    return this.rows.get(id) ?? null;
  }

  public async save(asset: Asset): Promise<void> {
    this.rows.set(asset.id, asset);
  }
}

export class InMemoryJobRepository implements JobRepository {
  public readonly rows = new Map<string, Job>();
  public readonly history: Job[] = [];

  public async insert(job: Job): Promise<void> {
    this.rows.set(job.id, job);
  }

  public async findById(id: string): Promise<Job | null> {
    return this.rows.get(id) ?? null;
  }

  public async save(job: Job): Promise<void> {
    this.rows.set(job.id, job);
    this.history.push(job);
  }

  public async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

export class InMemoryObjectStore implements ObjectStore {
  public readonly objects = new Map<string, { sizeBytes: number; contentType?: string }>();
  public readonly presigned: Array<{ key: string; contentType: string; sizeBytes: number }> = [];

  public async presignUpload(request: { key: string; contentType: string; sizeBytes: number }): Promise<string> {
    this.presigned.push({ key: request.key, contentType: request.contentType, sizeBytes: request.sizeBytes });
    return `https://s3.test/${request.key}?signed=put`;
  }

  public async presignDownload(request: { key: string }): Promise<string> {
    return `https://s3.test/${request.key}?signed=get`;
  }

  public async head(key: string): Promise<StoredObject | null> {
    const object = this.objects.get(key);
    return object === undefined ? null : { sizeBytes: object.sizeBytes };
  }

  public async download(key: string, destinationPath: string): Promise<void> {
    if (!this.objects.has(key)) {
      throw new Error(`no such key ${key}`);
    }
    await writeFile(destinationPath, "source-bytes");
  }

  public async upload(request: { key: string; sourcePath: string; contentType: string }): Promise<StoredObject> {
    const { size } = await stat(request.sourcePath);
    this.objects.set(request.key, { sizeBytes: size, contentType: request.contentType });
    return { sizeBytes: size };
  }
}

export class RecordingQueue implements JobQueue {
  public readonly enqueued: string[] = [];
  public failWith: Error | null = null;

  public async enqueue(jobId: string): Promise<void> {
    if (this.failWith !== null) {
      throw this.failWith;
    }
    this.enqueued.push(jobId);
  }
}

export class InMemoryProgressBus implements ProgressBus {
  public readonly published: JobEvent[] = [];
  private readonly listeners = new Map<string, Set<(event: JobEvent) => void>>();

  public async publish(event: JobEvent): Promise<void> {
    this.published.push(event);
    for (const listener of this.listeners.get(event.jobId) ?? []) {
      listener(event);
    }
  }

  public async subscribe(jobId: string, listener: (event: JobEvent) => void): Promise<Subscription> {
    const set = this.listeners.get(jobId) ?? new Set();
    set.add(listener);
    this.listeners.set(jobId, set);
    return { close: async () => void set.delete(listener) };
  }

  public listenerCount(jobId: string): number {
    return this.listeners.get(jobId)?.size ?? 0;
  }
}

export class ScriptedMediaTool implements MediaTool {
  public duration = 60;
  public probeError: Error | null = null;
  public executeError: Error | null = null;
  public progressSamples: number[] = [10, 50, 100];
  public readonly operations: MediaOperation[] = [];

  public async probe(): Promise<MediaInfo> {
    if (this.probeError !== null) {
      throw this.probeError;
    }
    return { durationSeconds: this.duration };
  }

  public async execute(operation: MediaOperation, onProgress: (percent: number) => void): Promise<void> {
    this.operations.push(operation);
    if (this.executeError !== null) {
      throw this.executeError;
    }
    for (const sample of this.progressSamples) {
      onProgress(sample);
    }
    await writeFile(operation.outputPath, "rendered-bytes");
  }
}

export class TempWorkspaceProvider implements WorkspaceProvider {
  public readonly created: string[] = [];
  public readonly disposed: string[] = [];

  public async create(): Promise<Workspace> {
    const directory = await mkdtemp(join(tmpdir(), "rq-test-"));
    this.created.push(directory);
    return {
      pathFor: (name) => join(directory, name),
      dispose: async () => {
        this.disposed.push(directory);
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
}
