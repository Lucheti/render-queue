import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStore, StoredObject } from "../../ports/object-store.js";
import type { HealthCheck } from "../../ports/support.js";

export interface S3ObjectStoreOptions {
  readonly bucket: string;
  /** Client for server-side calls (HEAD, GET, multipart upload). */
  readonly client: S3Client;
  /** Client whose endpoint is the one browsers can reach; used only to sign URLs. */
  readonly presignClient: S3Client;
}

/** ObjectStore backed by S3 or any S3-compatible service such as RustFS or MinIO. */
export class S3ObjectStore implements ObjectStore {
  public constructor(private readonly options: S3ObjectStoreOptions) {}

  public presignUpload(request: {
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresInSeconds: number;
  }): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: request.key,
      ContentType: request.contentType,
      ContentLength: request.sizeBytes,
    });
    return getSignedUrl(this.options.presignClient, command, {
      expiresIn: request.expiresInSeconds,
      signableHeaders: new Set(["content-type"]),
    });
  }

  public presignDownload(request: { key: string; filename: string; expiresInSeconds: number }): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: request.key,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(request.filename)}`,
    });
    return getSignedUrl(this.options.presignClient, command, { expiresIn: request.expiresInSeconds });
  }

  public async head(key: string): Promise<StoredObject | null> {
    try {
      const response = await this.options.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return { sizeBytes: response.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  public async download(key: string, destinationPath: string, signal?: AbortSignal): Promise<void> {
    const response = await this.options.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      signal === undefined ? {} : { abortSignal: signal },
    );
    if (!(response.Body instanceof Readable)) {
      throw new Error(`Unexpected body type for s3://${this.options.bucket}/${key}`);
    }
    await pipeline(response.Body, createWriteStream(destinationPath));
  }

  public async upload(request: {
    key: string;
    sourcePath: string;
    contentType: string;
    signal?: AbortSignal;
  }): Promise<StoredObject> {
    const upload = new Upload({
      client: this.options.client,
      params: {
        Bucket: this.options.bucket,
        Key: request.key,
        ContentType: request.contentType,
        Body: createReadStream(request.sourcePath),
      },
    });
    const abort = (): void => void upload.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    try {
      await upload.done();
    } finally {
      request.signal?.removeEventListener("abort", abort);
    }
    return { sizeBytes: (await stat(request.sourcePath)).size };
  }
}

/** Readiness probe that checks the bucket is reachable with the current credentials. */
export class S3HealthCheck implements HealthCheck {
  public readonly name = "s3";

  public constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  public async check(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof S3ServiceException && (error.name === "NotFound" || error.$metadata.httpStatusCode === 404);
}
