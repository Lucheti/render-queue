/** Metadata of an object that exists in storage. */
export interface StoredObject {
  readonly sizeBytes: number;
}

/** Blob storage, as the application needs it. */
export interface ObjectStore {
  /** A URL the browser can PUT the file to; the content type and length are bound to the signature. */
  presignUpload(request: {
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresInSeconds: number;
  }): Promise<string>;

  /** A URL the browser can GET the file from. */
  presignDownload(request: { key: string; filename: string; expiresInSeconds: number }): Promise<string>;

  /** Metadata for the object, or `null` when it does not exist. */
  head(key: string): Promise<StoredObject | null>;

  /** Streams the object to a local file. */
  download(key: string, destinationPath: string, signal?: AbortSignal): Promise<void>;

  /** Streams a local file to the bucket and reports what was stored. */
  upload(request: { key: string; sourcePath: string; contentType: string; signal?: AbortSignal }): Promise<StoredObject>;
}
