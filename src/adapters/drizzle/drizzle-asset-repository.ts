import { eq } from "drizzle-orm";
import { Asset, type AssetSnapshot } from "../../domain/asset.js";
import type { AssetRepository } from "../../ports/repositories.js";
import type { Database } from "./database.js";
import { assets, type AssetRow } from "./schema.js";

/** Stores assets in Postgres through Drizzle. */
export class DrizzleAssetRepository implements AssetRepository {
  public constructor(private readonly db: Database) {}

  public async insert(asset: Asset): Promise<void> {
    await this.db.insert(assets).values(DrizzleAssetRepository.toRow(asset.snapshot()));
  }

  public async findById(id: string): Promise<Asset | null> {
    const [row] = await this.db.select().from(assets).where(eq(assets.id, id)).limit(1);
    return row === undefined ? null : Asset.restore(DrizzleAssetRepository.toSnapshot(row));
  }

  public async save(asset: Asset): Promise<void> {
    const { id, ...values } = DrizzleAssetRepository.toRow(asset.snapshot());
    await this.db.update(assets).set(values).where(eq(assets.id, id));
  }

  private static toRow(snapshot: AssetSnapshot): AssetRow {
    return { ...snapshot };
  }

  private static toSnapshot(row: AssetRow): AssetSnapshot {
    return { ...row };
  }
}
