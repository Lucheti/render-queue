import { bigint, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { JobSpec } from "../../domain/job-spec.js";

export const assetOrigin = pgEnum("asset_origin", ["upload", "render"]);
export const assetStatus = pgEnum("asset_status", ["pending", "uploaded"]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "completed", "failed"]);

export const assets = pgTable("assets", {
  id: uuid("id").primaryKey(),
  origin: assetOrigin("origin").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  storageKey: text("storage_key").notNull().unique(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  status: assetStatus("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
});

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    kind: text("kind").notNull(),
    spec: jsonb("spec").$type<JobSpec>().notNull(),
    status: jobStatus("status").notNull(),
    progress: integer("progress").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    resultAssetId: uuid("result_asset_id").references(() => assets.id),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("jobs_asset_id_idx").on(table.assetId), index("jobs_status_idx").on(table.status)],
);

export type AssetRow = typeof assets.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
