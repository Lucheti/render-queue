import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { RenderQueueStack } from "../lib/render-queue-stack.js";

const app = new App();

new RenderQueueStack(app, "RenderQueue", {
  repositoryRoot: fileURLToPath(new URL("../../", import.meta.url)),
  env: { account: process.env["CDK_DEFAULT_ACCOUNT"], region: process.env["CDK_DEFAULT_REGION"] },
  description: "render-queue: presigned uploads, render jobs and SSE progress on ECS Fargate",
});
