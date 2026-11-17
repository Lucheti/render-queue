import type { Asset } from "../domain/asset.js";
import type { Job } from "../domain/job.js";

/** Persistence for jobs. */
export interface JobRepository {
  insert(job: Job): Promise<void>;
  findById(id: string): Promise<Job | null>;
  save(job: Job): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Persistence for assets. */
export interface AssetRepository {
  insert(asset: Asset): Promise<void>;
  findById(id: string): Promise<Asset | null>;
  save(asset: Asset): Promise<void>;
}
