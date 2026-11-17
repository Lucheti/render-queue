import { Duration, RemovalPolicy, aws_ec2 as ec2, aws_ecs as ecs, aws_logs as logs } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { AppEnvironment } from "./app-environment.js";
import type { Network } from "./network.js";

export interface WorkerServiceProps {
  readonly cluster: ecs.ICluster;
  readonly network: Network;
  readonly environment: AppEnvironment;
  readonly image: ecs.ContainerImage;
}

/** Seconds ECS waits after SIGTERM before SIGKILL; the worker drains for less than this. */
const STOP_TIMEOUT_SECONDS = 120;
const WORKER_DRAIN_MS = 100_000;

/** The render workers: no inbound traffic, they pull jobs from Redis. */
export class WorkerService extends Construct {
  public readonly service: ecs.FargateService;

  public constructor(scope: Construct, id: string, props: WorkerServiceProps) {
    super(scope, id);

    const taskDefinition = new ecs.FargateTaskDefinition(this, "Task", {
      cpu: 1_024,
      memoryLimitMiB: 2_048,
      ephemeralStorageGiB: 50,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    taskDefinition.addContainer("worker", {
      image: props.image,
      environment: {
        ...props.environment.variables,
        WORKER_CONCURRENCY: "2",
        WORK_DIR: "/tmp",
        SHUTDOWN_GRACE_MS: String(WORKER_DRAIN_MS),
      },
      secrets: { ...props.environment.secrets },
      stopTimeout: Duration.seconds(STOP_TIMEOUT_SECONDS),
      // A real init process reaps ffmpeg children and forwards SIGTERM.
      linuxParameters: new ecs.LinuxParameters(this, "Linux", { initProcessEnabled: true }),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "worker",
        logGroup: new logs.LogGroup(this, "Logs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      }),
    });
    props.environment.grantBucketAccess(taskDefinition.taskRole);

    this.service = new ecs.FargateService(this, "Service", {
      cluster: props.cluster,
      taskDefinition,
      desiredCount: 1,
      securityGroups: [props.network.workerSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    this.service
      .autoScaleTaskCount({ minCapacity: 1, maxCapacity: 10 })
      .scaleOnCpuUtilization("Cpu", { targetUtilizationPercent: 70, scaleInCooldown: Duration.minutes(10) });
  }
}
