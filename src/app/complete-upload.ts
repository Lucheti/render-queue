import type { AssetSnapshot } from "../domain/asset.js";
import { ByteSize } from "../domain/byte-size.js";
import { ConflictError, NotFoundError } from "../domain/errors.js";
import type { ObjectStore } from "../ports/object-store.js";
import type { AssetRepository } from "../ports/repositories.js";
import type { Clock } from "../ports/support.js";

/** Confirms that the client's direct upload landed in storage and marks the asset usable. */
export class CompleteUpload {
  public constructor(
    private readonly assets: AssetRepository,
    private readonly store: ObjectStore,
    private readonly clock: Clock,
    private readonly maxSize: ByteSize,
  ) {}

  /** Idempotent: completing an already uploaded asset returns it unchanged. */
  public async execute(assetId: string): Promise<AssetSnapshot> {
    const asset = await this.assets.findById(assetId);
    if (asset === null) {
      throw new NotFoundError("asset_not_found", `Asset ${assetId} does not exist.`);
    }
    if (asset.isUploaded()) {
      return asset.snapshot();
    }

    const stored = await this.store.head(asset.storageKey);
    if (stored === null) {
      throw new ConflictError("upload_missing", `No object has been uploaded for asset ${assetId} yet.`);
    }

    const uploaded = asset.markUploaded(ByteSize.of(stored.sizeBytes, this.maxSize), this.clock.now());
    await this.assets.save(uploaded);
    return uploaded.snapshot();
  }
}
