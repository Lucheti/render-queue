import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { CompleteUpload } from "../../app/complete-upload.js";
import type { CreateUpload } from "../../app/create-upload.js";
import { problemSchema } from "../problem.js";
import {
  assetParamsSchema,
  completedUploadSchema,
  uploadRequestSchema,
  uploadResponseSchema,
} from "../schemas.js";

export interface UploadRoutesDependencies {
  readonly createUpload: CreateUpload;
  readonly completeUpload: CompleteUpload;
}

/** `POST /uploads` and `POST /uploads/:assetId/complete`. */
export function uploadRoutes(deps: UploadRoutesDependencies): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/uploads",
      {
        schema: {
          tags: ["uploads"],
          summary: "Start an upload and get a presigned PUT URL",
          body: uploadRequestSchema,
          response: { 201: uploadResponseSchema, 400: problemSchema, 422: problemSchema },
        },
      },
      async (request, reply) => {
        const result = await deps.createUpload.execute(request.body);
        return reply.code(201).send({
          assetId: result.assetId,
          uploadUrl: result.uploadUrl,
          expiresAt: result.expiresAt.toISOString(),
          headers: result.uploadHeaders,
        });
      },
    );

    app.post(
      "/uploads/:assetId/complete",
      {
        schema: {
          tags: ["uploads"],
          summary: "Verify the object landed in storage and mark the asset uploaded",
          params: assetParamsSchema,
          response: { 200: completedUploadSchema, 404: problemSchema, 409: problemSchema, 422: problemSchema },
        },
      },
      async (request) => {
        const asset = await deps.completeUpload.execute(request.params.assetId);
        return {
          assetId: asset.id,
          status: "uploaded" as const,
          filename: asset.filename,
          contentType: asset.contentType,
          sizeBytes: asset.sizeBytes,
        };
      },
    );
  };
}
