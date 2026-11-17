import { z } from "zod";

/** Raised at start-up when the environment does not describe a runnable process. */
export class ConfigError extends Error {
  public constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export interface DatabaseConfig {
  readonly url: string;
  readonly ssl: boolean;
  readonly poolSize: number;
}

export interface S3Config {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint: string | undefined;
  readonly publicEndpoint: string | undefined;
  readonly forcePathStyle: boolean;
}

export interface QueueConfig {
  readonly redisUrl: string;
  readonly attempts: number;
  readonly backoffMs: number;
}

export interface ApiConfig {
  readonly logLevel: string;
  readonly host: string;
  readonly port: number;
  readonly apiKey: string;
  readonly corsOrigins: readonly string[];
  readonly maxUploadBytes: number;
  readonly uploadUrlTtlSeconds: number;
  readonly downloadUrlTtlSeconds: number;
  readonly rateLimit: { readonly max: number; readonly windowSeconds: number };
  readonly sseHeartbeatMs: number;
  readonly database: DatabaseConfig;
  readonly s3: S3Config;
  readonly queue: QueueConfig;
}

export interface WorkerConfig {
  readonly logLevel: string;
  readonly concurrency: number;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly workDir: string;
  readonly shutdownGraceMs: number;
  readonly progressRecordIntervalMs: number;
  readonly database: DatabaseConfig;
  readonly s3: S3Config;
  readonly queue: QueueConfig;
}

export interface MigrateConfig {
  readonly database: DatabaseConfig;
  readonly migrationsFolder: string;
}

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const databaseVars = {
  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().optional(),
  DB_PORT: positiveInt(5432),
  DB_NAME: z.string().optional(),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  DATABASE_POOL_SIZE: positiveInt(10),
};

const sharedVars = {
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  REDIS_URL: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  JOB_ATTEMPTS: positiveInt(3),
  JOB_BACKOFF_MS: positiveInt(5_000),
  ...databaseVars,
};

const apiSchema = z.object({
  ...sharedVars,
  HOST: z.string().default("0.0.0.0"),
  PORT: positiveInt(3000),
  API_KEY: z.string().min(16, "must be at least 16 characters"),
  CORS_ORIGINS: z.string().default(""),
  MAX_UPLOAD_BYTES: positiveInt(2 * 1024 ** 3),
  UPLOAD_URL_TTL_SECONDS: positiveInt(900),
  DOWNLOAD_URL_TTL_SECONDS: positiveInt(3_600),
  RATE_LIMIT_MAX: positiveInt(120),
  RATE_LIMIT_WINDOW_SECONDS: positiveInt(60),
  SSE_HEARTBEAT_MS: positiveInt(15_000),
});

const workerSchema = z.object({
  ...sharedVars,
  WORKER_CONCURRENCY: positiveInt(2),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  WORK_DIR: z.string().default("/tmp"),
  SHUTDOWN_GRACE_MS: positiveInt(100_000),
  PROGRESS_RECORD_INTERVAL_MS: z.coerce.number().int().min(0).default(1_000),
});

const migrateSchema = z.object({
  ...databaseVars,
  MIGRATIONS_DIR: z.string().default("drizzle"),
});

type Env = Readonly<Record<string, string | undefined>>;
type Shared = z.infer<z.ZodObject<typeof sharedVars>>;
type DatabaseVars = z.infer<z.ZodObject<typeof databaseVars>>;

function parse<T extends z.ZodType>(schema: T, env: Env): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  return result.data;
}

function databaseOf(vars: DatabaseVars): DatabaseConfig {
  const { DATABASE_URL, DB_HOST, DB_NAME, DB_USER, DB_PASSWORD } = vars;
  let url = DATABASE_URL;
  if (url === undefined) {
    if (DB_HOST === undefined || DB_NAME === undefined || DB_USER === undefined || DB_PASSWORD === undefined) {
      throw new ConfigError(["set DATABASE_URL, or all of DB_HOST, DB_NAME, DB_USER and DB_PASSWORD"]);
    }
    url = `postgres://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${vars.DB_PORT}/${DB_NAME}`;
  }
  return { url, ssl: vars.DATABASE_SSL === "require", poolSize: vars.DATABASE_POOL_SIZE };
}

function s3Of(vars: Shared): S3Config {
  return {
    bucket: vars.S3_BUCKET,
    region: vars.S3_REGION,
    endpoint: vars.S3_ENDPOINT,
    publicEndpoint: vars.S3_PUBLIC_ENDPOINT,
    forcePathStyle: vars.S3_FORCE_PATH_STYLE,
  };
}

function queueOf(vars: Shared): QueueConfig {
  return { redisUrl: vars.REDIS_URL, attempts: vars.JOB_ATTEMPTS, backoffMs: vars.JOB_BACKOFF_MS };
}

/** Reads and validates the API process configuration. */
export function loadApiConfig(env: Env): ApiConfig {
  const vars = parse(apiSchema, env);
  return {
    logLevel: vars.LOG_LEVEL,
    host: vars.HOST,
    port: vars.PORT,
    apiKey: vars.API_KEY,
    corsOrigins: vars.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    maxUploadBytes: vars.MAX_UPLOAD_BYTES,
    uploadUrlTtlSeconds: vars.UPLOAD_URL_TTL_SECONDS,
    downloadUrlTtlSeconds: vars.DOWNLOAD_URL_TTL_SECONDS,
    rateLimit: { max: vars.RATE_LIMIT_MAX, windowSeconds: vars.RATE_LIMIT_WINDOW_SECONDS },
    sseHeartbeatMs: vars.SSE_HEARTBEAT_MS,
    database: databaseOf(vars),
    s3: s3Of(vars),
    queue: queueOf(vars),
  };
}

/** Reads and validates the worker process configuration. */
export function loadWorkerConfig(env: Env): WorkerConfig {
  const vars = parse(workerSchema, env);
  return {
    logLevel: vars.LOG_LEVEL,
    concurrency: vars.WORKER_CONCURRENCY,
    ffmpegPath: vars.FFMPEG_PATH,
    ffprobePath: vars.FFPROBE_PATH,
    workDir: vars.WORK_DIR,
    shutdownGraceMs: vars.SHUTDOWN_GRACE_MS,
    progressRecordIntervalMs: vars.PROGRESS_RECORD_INTERVAL_MS,
    database: databaseOf(vars),
    s3: s3Of(vars),
    queue: queueOf(vars),
  };
}

/** Reads and validates the migration command configuration. */
export function loadMigrateConfig(env: Env): MigrateConfig {
  const vars = parse(migrateSchema, env);
  return { database: databaseOf(vars), migrationsFolder: vars.MIGRATIONS_DIR };
}
