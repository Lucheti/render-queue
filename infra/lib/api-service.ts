import {
  Duration,
  RemovalPolicy,
  aws_certificatemanager as acm,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_ecs_patterns as ecsPatterns,
  aws_elasticloadbalancingv2 as elbv2,
  aws_logs as logs,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import type { AppEnvironment } from "./app-environment.js";
import type { Network } from "./network.js";

const API_PORT = 3000;

export interface ApiServiceProps {
  readonly cluster: ecs.ICluster;
  readonly network: Network;
  readonly environment: AppEnvironment;
  readonly image: ecs.ContainerImage;
  /** When set, the load balancer terminates TLS with this ACM certificate; otherwise it serves plain HTTP. */
  readonly certificateArn?: string;
}

/** The API tasks behind an Application Load Balancer. */
export class ApiService extends Construct {
  public readonly service: ecsPatterns.ApplicationLoadBalancedFargateService;

  public constructor(scope: Construct, id: string, props: ApiServiceProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, "Logs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });

    this.service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Service", {
      cluster: props.cluster,
      cpu: 512,
      memoryLimitMiB: 1_024,
      desiredCount: 2,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.network.apiSecurityGroup],
      publicLoadBalancer: true,
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: Duration.seconds(60),
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      ...(props.certificateArn === undefined
        ? {}
        : {
            protocol: elbv2.ApplicationProtocol.HTTPS,
            certificate: acm.Certificate.fromCertificateArn(this, "Certificate", props.certificateArn),
            redirectHTTP: true,
          }),
      taskImageOptions: {
        image: props.image,
        containerPort: API_PORT,
        environment: { ...props.environment.variables, PORT: String(API_PORT) },
        secrets: { ...props.environment.withApiKey() },
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: "api", logGroup }),
      },
    });

    props.environment.grantBucketAccess(this.service.taskDefinition.taskRole);

    this.service.targetGroup.configureHealthCheck({ path: "/health", healthyHttpCodes: "200", interval: Duration.seconds(15) });
    this.service.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "30");
    // Server-sent events keep a connection open; the API sends a heartbeat every 15 s, well inside this timeout.
    this.service.loadBalancer.setAttribute("idle_timeout.timeout_seconds", "120");

    this.service.service
      .autoScaleTaskCount({ minCapacity: 2, maxCapacity: 6 })
      .scaleOnCpuUtilization("Cpu", { targetUtilizationPercent: 60 });
  }
}
