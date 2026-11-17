import { eq } from "drizzle-orm";
import { Job, type JobSnapshot } from "../../domain/job.js";
import type { JobRepository } from "../../ports/repositories.js";
import type { Database } from "./database.js";
import { jobs, type JobRow } from "./schema.js";

/** Stores jobs in Postgres through Drizzle. */
export class DrizzleJobRepository implements JobRepository {
  public constructor(private readonly db: Database) {}

  public async insert(job: Job): Promise<void> {
    await this.db.insert(jobs).values(DrizzleJobRepository.toRow(job.snapshot()));
  }

  public async findById(id: string): Promise<Job | null> {
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    return row === undefined ? null : Job.restore(DrizzleJobRepository.toSnapshot(row));
  }

  public async save(job: Job): Promise<void> {
    const { id, ...values } = DrizzleJobRepository.toRow(job.snapshot());
    await this.db.update(jobs).set(values).where(eq(jobs.id, id));
  }

  public async delete(id: string): Promise<void> {
    await this.db.delete(jobs).where(eq(jobs.id, id));
  }

  private static toRow(snapshot: JobSnapshot): JobRow {
    return {
      id: snapshot.id,
      assetId: snapshot.assetId,
      kind: snapshot.spec.kind,
      spec: snapshot.spec,
      status: snapshot.status,
      progress: snapshot.progress,
      attempts: snapshot.attempts,
      resultAssetId: snapshot.resultAssetId,
      errorCode: snapshot.error?.code ?? null,
      errorMessage: snapshot.error?.message ?? null,
      createdAt: snapshot.createdAt,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
    };
  }

  private static toSnapshot(row: JobRow): JobSnapshot {
    return {
      id: row.id,
      assetId: row.assetId,
      spec: row.spec,
      status: row.status,
      progress: row.progress,
      attempts: row.attempts,
      resultAssetId: row.resultAssetId,
      error:
        row.errorCode === null || row.errorMessage === null
          ? null
          : { code: row.errorCode, message: row.errorMessage },
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }
}
