import { Duration, RemovalPolicy, aws_ec2 as ec2, aws_elasticache as elasticache, aws_rds as rds, aws_s3 as s3, aws_secretsmanager as secretsmanager } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { Network } from "./network.js";

export interface DataProps {
  readonly network: Network;
  /** Origins allowed to PUT and GET objects straight from the browser. */
  readonly corsOrigins: readonly string[];
}

const REDIS_PORT = 6379;

/** Everything that holds state: the media bucket, Postgres, Redis and the API key secret. */
export class Data extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly database: rds.DatabaseInstance;
  public readonly redisUrl: string;
  public readonly apiKey: secretsmanager.Secret;

  public constructor(scope: Construct, id: string, props: DataProps) {
    super(scope, id);
    const { network } = props;

    this.bucket = new s3.Bucket(this, "Media", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: [...props.corsOrigins],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3_000,
        },
      ],
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
        { prefix: "uploads/", expiration: Duration.days(30) },
        { prefix: "renders/", expiration: Duration.days(30) },
      ],
    });

    this.database = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [network.databaseSecurityGroup],
      databaseName: "render",
      credentials: rds.Credentials.fromGeneratedSecret("render"),
      allocatedStorage: 20,
      storageEncrypted: true,
      backupRetention: Duration.days(7),
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });

    this.redisUrl = this.createRedis(network);

    this.apiKey = new secretsmanager.Secret(this, "ApiKey", {
      description: "Value clients send in the x-api-key header",
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
    });
  }

  private createRedis(network: Network): string {
    const subnets = new elasticache.CfnSubnetGroup(this, "RedisSubnets", {
      description: "render-queue redis",
      subnetIds: network.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });
    // BullMQ stores jobs in Redis: evicting keys under memory pressure would silently lose queued work.
    const parameters = new elasticache.CfnParameterGroup(this, "RedisParameters", {
      cacheParameterGroupFamily: "redis7",
      description: "render-queue: never evict",
      properties: { "maxmemory-policy": "noeviction" },
    });
    const redis = new elasticache.CfnReplicationGroup(this, "Redis", {
      replicationGroupDescription: "render-queue queue and pub/sub",
      engine: "redis",
      engineVersion: "7.1",
      cacheNodeType: "cache.t4g.micro",
      numCacheClusters: 1,
      automaticFailoverEnabled: false,
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      port: REDIS_PORT,
      cacheSubnetGroupName: subnets.ref,
      cacheParameterGroupName: parameters.ref,
      securityGroupIds: [network.cacheSecurityGroup.securityGroupId],
    });
    return `rediss://${redis.attrPrimaryEndPointAddress}:${redis.attrPrimaryEndPointPort}`;
  }
}
