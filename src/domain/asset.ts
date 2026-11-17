import type { ByteSize } from "./byte-size.js";
import type { ContentType } from "./content-type.js";
import { ConflictError } from "./errors.js";
import type { Filename } from "./filename.js";

export type AssetOrigin = "upload" | "render";
export type AssetStatus = "pending" | "uploaded";

/** Plain, persistable state of an Asset. */
export interface AssetSnapshot {
  readonly id: string;
  readonly origin: AssetOrigin;
  readonly filename: string;
  readonly contentType: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly status: AssetStatus;
  readonly createdAt: Date;
  readonly uploadedAt: Date | null;
}

/** A stored media file. It starts `pending` and becomes `uploaded` exactly once. */
export class Asset {
  private constructor(private readonly state: AssetSnapshot) {}

  /** An upload the client has been invited to make but has not completed. */
  public static requestUpload(input: {
    id: string;
    storageKey: string;
    filename: Filename;
    contentType: ContentType;
    size: ByteSize;
    now: Date;
  }): Asset {
    return new Asset({
      id: input.id,
      origin: "upload",
      filename: input.filename.toString(),
      contentType: input.contentType.toString(),
      storageKey: input.storageKey,
      sizeBytes: input.size.toNumber(),
      status: "pending",
      createdAt: input.now,
      uploadedAt: null,
    });
  }

  /** A file the worker produced and has already stored. */
  public static rendered(input: {
    id: string;
    storageKey: string;
    filename: Filename;
    contentType: ContentType;
    size: ByteSize;
    now: Date;
  }): Asset {
    return new Asset({
      id: input.id,
      origin: "render",
      filename: input.filename.toString(),
      contentType: input.contentType.toString(),
      storageKey: input.storageKey,
      sizeBytes: input.size.toNumber(),
      status: "uploaded",
      createdAt: input.now,
      uploadedAt: input.now,
    });
  }

  /** Rebuilds an Asset from persisted state. */
  public static restore(snapshot: AssetSnapshot): Asset {
    return new Asset(snapshot);
  }

  /** Records the verified object size and flips the asset to `uploaded`. */
  public markUploaded(actualSize: ByteSize, now: Date): Asset {
    if (this.state.status === "uploaded") {
      throw new ConflictError("asset_already_uploaded", `Asset ${this.state.id} is already uploaded.`);
    }
    return new Asset({
      ...this.state,
      sizeBytes: actualSize.toNumber(),
      status: "uploaded",
      uploadedAt: now,
    });
  }

  /** The asset's identifier. */
  public get id(): string {
    return this.state.id;
  }

  /** The object key in the bucket. */
  public get storageKey(): string {
    return this.state.storageKey;
  }

  /** Whether the object has been verified in storage. */
  public isUploaded(): boolean {
    return this.state.status === "uploaded";
  }

  /** A read-only copy of the state, for persistence and presentation. */
  public snapshot(): AssetSnapshot {
    return this.state;
  }
}
