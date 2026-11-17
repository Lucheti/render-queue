import { aws_ec2 as ec2 } from "aws-cdk-lib";
import { Construct } from "constructs";

/** The VPC and one security group per tier, so each hop in the architecture is an explicit rule. */
export class Network extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly apiSecurityGroup: ec2.SecurityGroup;
  public readonly workerSecurityGroup: ec2.SecurityGroup;
  public readonly databaseSecurityGroup: ec2.SecurityGroup;
  public readonly cacheSecurityGroup: ec2.SecurityGroup;

  public constructor(scope: Construct, id: string) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "app", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    this.vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });

    this.apiSecurityGroup = this.securityGroup("Api", "api tasks");
    this.workerSecurityGroup = this.securityGroup("Worker", "worker tasks");
    this.databaseSecurityGroup = this.securityGroup("Database", "postgres");
    this.cacheSecurityGroup = this.securityGroup("Cache", "redis");

    for (const tier of [this.apiSecurityGroup, this.workerSecurityGroup]) {
      this.databaseSecurityGroup.addIngressRule(tier, ec2.Port.tcp(5432), "tasks to postgres");
      this.cacheSecurityGroup.addIngressRule(tier, ec2.Port.tcp(6379), "tasks to redis");
    }
  }

  private securityGroup(name: string, description: string): ec2.SecurityGroup {
    return new ec2.SecurityGroup(this, `${name}Sg`, { vpc: this.vpc, description: `render-queue ${description}` });
  }
}
