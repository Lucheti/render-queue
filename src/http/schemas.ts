import { z } from "zod";
import type { CreateJobCommand } from "../app/create-job.js";
import { assertNever } from "../domain/assert-never.js";
import { JOB_STATUSES } from "../domain/job-status.js";
import { TRANSCODE_PRESETS } from "../domain/job-spec.js";

const isoDate = z.iso.datetime();

export const uploadRequestSchema = z.object({
  filename: z.string().min(1).max(255).describe("Original file name."),
  contentType: z.string().min(1).max(255).describe("MIME type; only video/* is accepted."),
  size: z.number().int().positive().describe("File size in bytes."),
});

export const uploadResponseSchema = z.object({
  assetId: z.uuid(),
  uploadUrl: z.url().describe("Presigned S3 PUT URL."),
  expiresAt: isoDate,
  headers: z.record(z.string(), z.string()).describe("Headers the PUT request must carry."),
});

export const assetParamsSchema = z.object({ assetId: z.uuid() });

export const completedUploadSchema = z.object({
  assetId: z.uuid(),
  status: z.literal("uploaded"),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
});

const assetId = z.uuid().describe("An uploaded asset.");

export const createJobRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    assetId,
    kind: z.literal("thumbnail"),
    params: z.object({ time: z.number().min(0).describe("Seconds into the video.") }),
  }),
  z.object({
    assetId,
    kind: z.literal("transcode"),
    params: z.object({ preset: z.enum(TRANSCODE_PRESETS) }),
  }),
  z.object({
    assetId,
    kind: z.literal("trim"),
    params: z.object({
      start: z.number().min(0).describe("Start, in seconds."),
      end: z.number().positive().describe("End, in seconds; must be greater than start."),
    }),
  }),
]);
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;

export const createJobResponseSchema = z.object({ jobId: z.uuid() });

export const jobParamsSchema = z.object({ id: z.uuid() });

export const jobViewSchema = z.object({
  id: z.uuid(),
  assetId: z.uuid(),
  kind: z.enum(["thumbnail", "transcode", "trim"]),
  status: z.enum(JOB_STATUSES),
  progress: z.number().int().min(0).max(100),
  attempts: z.number().int(),
  createdAt: isoDate,
  startedAt: isoDate.nullable(),
  finishedAt: isoDate.nullable(),
  result: z
    .object({
      assetId: z.uuid(),
      filename: z.string(),
      contentType: z.string(),
      sizeBytes: z.number().int(),
      downloadUrl: z.url().describe("Presigned S3 GET URL."),
      expiresAt: isoDate,
    })
    .nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export const healthSchema = z.object({ status: z.literal("ok") });

export const readinessSchema = z.object({
  status: z.literal("ready"),
  checks: z.record(z.string(), z.enum(["ok", "failed"])),
});

/** Converts a validated request body into the application command. */
export function toCreateJobCommand(body: CreateJobRequest): CreateJobCommand {
  switch (body.kind) {
    case "thumbnail":
      return { assetId: body.assetId, spec: { kind: "thumbnail", time: body.params.time } };
    case "transcode":
      return { assetId: body.assetId, spec: { kind: "transcode", preset: body.params.preset } };
    case "trim":
      return { assetId: body.assetId, spec: { kind: "trim", start: body.params.start, end: body.params.end } };
    default:
      return assertNever(body);
  }
}
