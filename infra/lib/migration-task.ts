import { RemovalPolicy, aws_ecs as ecs, aws_logs as logs } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { AppEnvironment } from "./app-environment.js";

export interface MigrationTaskProps {
  readonly environment: AppEnvironment;
  readonly image: ecs.ContainerImage;
}

/** A task definition, not a service: it is run once per release with `aws ecs run-task`, so replicas never race on migrations. */
export class MigrationTask extends Construct {
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  public constructor(scope: Construct, id: string, props: MigrationTaskProps) {
    super(scope, id);

    this.taskDefinition = new ecs.FargateTaskDefinition(this, "Task", { cpu: 256, memoryLimitMiB: 512 });
    this.taskDefinition.addContainer("migrate", {
      image: props.image,
      command: ["node", "dist/migrate.js"],
      environment: { ...props.environment.variables },
      secrets: { ...props.environment.secrets },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "migrate",
        logGroup: new logs.LogGroup(this, "Logs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      }),
    });
  }
}
