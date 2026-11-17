# render-queue: spec

An API for media uploads and render jobs: presigned S3 uploads, a job queue with workers, and progress over
server-sent events. It ships as containers for AWS ECS Fargate. It is a showcase repository: the back end a
browser video tool needs, written the way a production Node.js service should be.

## Scope (locked)

### API (Fastify, TypeScript)
- **`POST /uploads`:** `{ filename, contentType, size }` returns `{ assetId, uploadUrl }`, a presigned S3 PUT.
  It validates the type (video/*) and the size limit.
- **`POST /uploads/:assetId/complete`:** verifies the object exists (HEAD), reads its size, and marks the asset
  `uploaded`.
- **`POST /jobs`:** `{ assetId, kind, params }`, where `kind` is `thumbnail` (time), `transcode` (preset: 720p
  H.264 or 480p H.264), or `trim` (start, end). Returns `{ jobId }` and enqueues the job.
- **`GET /jobs/:id`:** status, progress (0–100), result asset (with a presigned GET URL) or error.
- **`GET /jobs/:id/events`:** server-sent events with `progress`, `completed` and `failed`, from the worker through
  Redis pub/sub. It sends heartbeats and closes when the job ends.
- **`GET /health`** (liveness) and **`GET /ready`** (Postgres, Redis and S3 reachable).
- **Errors and contract:** errors use RFC 9457 problem+json. Request and response schemas are Zod, with OpenAPI
  generated from them and served at `/docs`.
- **Auth:** a simple API-key header (from env), timing-safe compared, so the demo is not open. Requests are
  rate-limited.

### Worker
- **Queue:** a BullMQ worker on the same Redis.
- **Each job:**
  - downloads the source from S3 to a temporary directory;
  - runs ffmpeg/ffprobe through a small `MediaTool` interface;
  - parses ffmpeg progress into percentages;
  - uploads the result;
  - writes the status to Postgres;
  - publishes progress.
- **Retries:** jobs retry with backoff (3 attempts); permanent errors such as bad input are not retried.
- **Concurrency and shutdown:** concurrency is configurable. A graceful shutdown on SIGTERM lets the current job
  finish or re-queue, which is how ECS stops tasks.

### Data
- Postgres with Drizzle: the tables `assets` and `jobs`, migrations committed, and status transitions guarded in one
  place (a job can only move queued → running → completed | failed).

### Infra
- **Images:** `Dockerfile`s for the api and the worker, multi-stage, non-root, and the worker includes ffmpeg.
- **Local stack:** `docker-compose.yml` runs Postgres, Redis, MinIO (S3), the api and the worker. `pnpm dev`
  works against it.
- **AWS (not deployed):** `infra/` holds AWS CDK (TypeScript) for VPC, ECS Fargate services for the api (behind an
  ALB) and the worker, RDS Postgres, ElastiCache Redis, an S3 bucket, task roles with least privilege, and log
  groups. `cdk synth` must succeed. It is documented, not deployed.

## Architecture
Hexagonal and small:
- **`domain/`:** Asset, Job, status rules, and the job kinds as a discriminated union. Pure and tested.
- **`app/`:** use cases (CreateUpload, CompleteUpload, CreateJob, RunJob).
- **`ports/`:** the interfaces ObjectStore, JobQueue, JobRepository, MediaTool and ProgressBus.
- **`adapters/`:** S3, BullMQ, Drizzle, ffmpeg and Redis pub/sub.
- **Composition:** one composition root per process (api, worker).

## Repository standards
- Node 22, TypeScript strict, Fastify, Zod, BullMQ, Drizzle, `@aws-sdk/client-s3` + `s3-request-presigner`,
  Vitest, ESLint, and pnpm.
- **Tests:** unit tests for the domain and the use cases (with in-memory fakes of the ports), and a parser test for
  ffmpeg progress. Integration tests that need Docker are tagged and skipped unless `INTEGRATION=1`.
- `pnpm gate` = typecheck + lint + unit tests + build. A GitHub Actions workflow runs the gate. A second job runs
  the integration tests with service containers.
- **README:**
  - two sentences on what it is;
  - a sequence diagram (mermaid): upload → complete → job → worker → SSE;
  - the endpoints table;
  - running it locally with compose, with a curl walkthrough;
  - the AWS architecture diagram and the CDK notes;
  - the design choices (why presigned uploads, why SSE over websockets, idempotency and retries).
- MIT licence.
