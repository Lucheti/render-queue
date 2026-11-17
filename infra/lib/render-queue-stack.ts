import { CfnOutput, Stack, type StackProps, aws_ecs as ecs } from "aws-cdk-lib";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import type { Construct } from "constructs";
import { ApiService } from "./api-service.js";
import { AppEnvironment } from "./app-environment.js";
import { Data } from "./data.js";
import { MigrationTask } from "./migration-task.js";
import { Network } from "./network.js";
import { WorkerService } from "./worker-service.js";

export interface RenderQueueStackProps extends StackProps {
  /** Directory holding the Dockerfiles; the images are built from here at deploy time. */
  readonly repositoryRoot: string;
}

/**
 * The whole system in one stack: VPC, Postgres, Redis, the media bucket, the API behind an ALB and the workers.
 * Context options: `corsOrigins` (list, default ["*"]) and `certificateArn` (enables HTTPS on the ALB).
 */
export class RenderQueueStack extends Stack {
  public constructor(scope: Construct, id: string, props: RenderQueueStackProps) {
    super(scope, id, props);

    const corsOrigins = (this.node.tryGetContext("corsOrigins") as string[] | undefined) ?? ["*"];
    const certificateArn = this.node.tryGetContext("certificateArn") as string | undefined;

    const network = new Network(this, "Network");
    const data = new Data(this, "Data", { network, corsOrigins });
    const environment = new AppEnvironment(data, this);
    const cluster = new ecs.Cluster(this, "Cluster", { vpc: network.vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED });

    const platform = { platform: Platform.LINUX_AMD64 } as const;
    const apiImage = ecs.ContainerImage.fromAsset(props.repositoryRoot, { file: "Dockerfile.api", ...platform });
    const workerImage = ecs.ContainerImage.fromAsset(props.repositoryRoot, { file: "Dockerfile.worker", ...platform });

    const api = new ApiService(this, "Api", {
      cluster,
      network,
      environment,
      image: apiImage,
      ...(certificateArn === undefined ? {} : { certificateArn }),
    });
    new WorkerService(this, "Worker", { cluster, network, environment, image: workerImage });
    const migration = new MigrationTask(this, "Migration", { environment, image: apiImage });

    const scheme = certificateArn === undefined ? "http" : "https";
    new CfnOutput(this, "ApiUrl", { value: `${scheme}://${api.service.loadBalancer.loadBalancerDnsName}` });
    new CfnOutput(this, "BucketName", { value: data.bucket.bucketName });
    new CfnOutput(this, "ApiKeySecretArn", { value: data.apiKey.secretArn });
    new CfnOutput(this, "MigrateCommand", {
      description: "Run once per release, before the services pick up the new image",
      value: [
        "aws ecs run-task",
        `--cluster ${cluster.clusterName}`,
        `--task-definition ${migration.taskDefinition.family}`,
        "--launch-type FARGATE",
        `--network-configuration "awsvpcConfiguration={subnets=[${network.vpc.privateSubnets.map((subnet) => subnet.subnetId).join(",")}],securityGroups=[${network.apiSecurityGroup.securityGroupId}],assignPublicIp=DISABLED}"`,
      ].join(" "),
    });
  }
}
