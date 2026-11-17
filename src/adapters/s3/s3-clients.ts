import { S3Client } from "@aws-sdk/client-s3";

export interface S3ClientSettings {
  readonly region: string;
  /** Endpoint for server-side calls; unset means real AWS. */
  readonly endpoint: string | undefined;
  /** Endpoint browsers use to reach the bucket; defaults to `endpoint`. */
  readonly publicEndpoint: string | undefined;
  readonly forcePathStyle: boolean;
}

/** The pair of clients the object store needs. */
export interface S3Clients {
  readonly client: S3Client;
  readonly presignClient: S3Client;
}

/**
 * Builds the server-side client and the signing client. Credentials come from the default AWS provider chain
 * (task role on ECS, `AWS_ACCESS_KEY_ID` locally). Checksums are only computed when S3 requires them, otherwise
 * presigned PUT URLs would embed the checksum of an empty body and every upload would be rejected.
 */
export function createS3Clients(settings: S3ClientSettings): S3Clients {
  const base = {
    region: settings.region,
    forcePathStyle: settings.forcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  } as const;
  const client = new S3Client({ ...base, ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint }) });
  const publicEndpoint = settings.publicEndpoint ?? settings.endpoint;
  const presignClient =
    publicEndpoint === settings.endpoint
      ? client
      : new S3Client({ ...base, ...(publicEndpoint === undefined ? {} : { endpoint: publicEndpoint }) });
  return { client, presignClient };
}
