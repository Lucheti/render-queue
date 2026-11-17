import { Asset } from "../domain/asset.js";
import { ByteSize } from "../domain/byte-size.js";
import { ContentType } from "../domain/content-type.js";
import { Filename } from "../domain/filename.js";
import type { ObjectStore } from "../ports/object-store.js";
import type { AssetRepository } from "../ports/repositories.js";
import type { Clock, IdGenerator } from "../ports/support.js";

export interface CreateUploadCommand {
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
}

export interface CreateUploadResult {
  readonly assetId: string;
  readonly uploadUrl: string;
  readonly expiresAt: Date;
  /** Headers the client must send with the PUT for the signature to match. */
  readonly uploadHeaders: Readonly<Record<string, string>>;
}

export interface UploadPolicy {
  readonly maxSize: ByteSize;
  readonly urlTtlSeconds: number;
}

/** Registers an asset and hands the client a presigned URL to upload it straight to storage. */
export class CreateUpload {
  public constructor(
    private readonly assets: AssetRepository,
    private readonly store: ObjectStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policy: UploadPolicy,
  ) {}

  /** Validates the request, records a pending asset and returns the upload URL. */
  public async execute(command: CreateUploadCommand): Promise<CreateUploadResult> {
    const filename = Filename.of(command.filename);
    const contentType = ContentType.video(command.contentType);
    const size = ByteSize.of(command.size, this.policy.maxSize);

    const now = this.clock.now();
    const id = this.ids.next();
    const storageKey = `uploads/${id}`;

    const uploadUrl = await this.store.presignUpload({
      key: storageKey,
      contentType: contentType.toString(),
      sizeBytes: size.toNumber(),
      expiresInSeconds: this.policy.urlTtlSeconds,
    });
    await this.assets.insert(Asset.requestUpload({ id, storageKey, filename, contentType, size, now }));

    return {
      assetId: id,
      uploadUrl,
      expiresAt: new Date(now.getTime() + this.policy.urlTtlSeconds * 1000),
      uploadHeaders: { "Content-Type": contentType.toString() },
    };
  }
}
