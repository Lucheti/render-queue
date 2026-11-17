import { Stack, aws_ecs as ecs, aws_iam as iam } from "aws-cdk-lib";
import type { Data } from "./data.js";

/** The environment variables and secrets every render-queue container shares. */
export class AppEnvironment {
  public readonly variables: Readonly<Record<string, string>>;
  public readonly secrets: Readonly<Record<string, ecs.Secret>>;

  public constructor(
    private readonly data: Data,
    stack: Stack,
  ) {
    this.variables = {
      DB_HOST: data.database.dbInstanceEndpointAddress,
      DB_PORT: data.database.dbInstanceEndpointPort,
      DB_NAME: "render",
      DB_USER: "render",
      DATABASE_SSL: "require",
      REDIS_URL: data.redisUrl,
      S3_BUCKET: data.bucket.bucketName,
      S3_REGION: stack.region,
      LOG_LEVEL: "info",
    };
    const databaseSecret = data.database.secret;
    if (databaseSecret === undefined) {
      throw new Error("The database was created without a generated secret.");
    }
    this.secrets = { DB_PASSWORD: ecs.Secret.fromSecretsManager(databaseSecret, "password") };
  }

  /** The API additionally needs the key clients must present. */
  public withApiKey(): Readonly<Record<string, ecs.Secret>> {
    return { ...this.secrets, API_KEY: ecs.Secret.fromSecretsManager(this.data.apiKey) };
  }

  /** Least privilege: objects can be read and written, the bucket listed (so a missing key is a 404, not a 403). Nothing else. */
  public grantBucketAccess(role: iam.IRole): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "ReadWriteMediaObjects",
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [this.data.bucket.arnForObjects("*")],
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "ListMediaBucket",
        actions: ["s3:ListBucket"],
        resources: [this.data.bucket.bucketArn],
      }),
    );
  }
}
