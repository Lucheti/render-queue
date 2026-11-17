import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Clock, IdGenerator, Workspace, WorkspaceProvider } from "../../ports/support.js";

/** Wall-clock time. */
export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

/** Random UUIDs (v4). */
export class UuidGenerator implements IdGenerator {
  public next(): string {
    return randomUUID();
  }
}

/** Scratch directories under a base path, removed on dispose. */
export class TempDirWorkspaceProvider implements WorkspaceProvider {
  public constructor(private readonly baseDir: string) {}

  public async create(): Promise<Workspace> {
    const directory = await mkdtemp(join(this.baseDir, "render-"));
    return {
      pathFor: (name) => join(directory, name),
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  }
}
