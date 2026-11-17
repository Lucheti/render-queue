import { STATUS_CODES } from "node:http";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { z } from "zod";
import { DomainError, type ErrorKind } from "../domain/errors.js";

/** Content type of every error response (RFC 9457). */
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** One invalid field of a request. */
export interface ProblemFieldError {
  readonly in: string;
  readonly pointer: string;
  readonly detail: string;
}

/** An RFC 9457 problem details object, with `code` and `errors` as extension members. */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance?: string;
  readonly code: string;
  readonly errors?: readonly ProblemFieldError[];
  readonly [extension: string]: unknown;
}

/** Zod schema documenting the problem shape in OpenAPI. */
export const problemSchema = z
  .object({
    type: z.string().describe("URN identifying the problem type."),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    instance: z.string().optional().describe("Path of the request that failed."),
    code: z.string().describe("Stable machine-readable error code."),
    errors: z
      .array(z.object({ in: z.string(), pointer: z.string(), detail: z.string() }))
      .optional()
      .describe("Field-level validation errors."),
  })
  .loose();

/** The caller did not present a valid API key. */
export class UnauthorizedError extends Error {
  public readonly statusCode = 401;

  public constructor() {
    super("A valid API key is required in the x-api-key header.");
    this.name = "UnauthorizedError";
  }
}

/** The caller exceeded the request rate limit. */
export class RateLimitedError extends Error {
  public readonly statusCode = 429;

  public constructor(retryAfter: string) {
    super(`Too many requests. Retry in ${retryAfter}.`);
    this.name = "RateLimitedError";
  }
}

const STATUS_BY_KIND: Readonly<Record<ErrorKind, number>> = {
  validation: 422,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
};

/** Translates any error raised while serving a request into a problem details object. */
export class ProblemMapper {
  /** Builds the problem for `error`. Unknown errors become an opaque 500 so internals never leak. */
  public map(error: unknown, instance: string): Problem {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return this.build(400, "validation_failed", "The request does not match the schema.", instance, {
        errors: error.validation.map((issue) => ({
          in: error.validationContext ?? "request",
          pointer: issue.instancePath === "" ? "/" : issue.instancePath,
          detail: issue.message ?? "Invalid value.",
        })),
      });
    }
    if (error instanceof DomainError) {
      return this.build(STATUS_BY_KIND[error.kind], error.code, error.message, instance);
    }
    if (error instanceof UnauthorizedError) {
      return this.build(401, "unauthorized", error.message, instance);
    }
    if (error instanceof RateLimitedError) {
      return this.build(429, "rate_limited", error.message, instance);
    }
    if (isResponseSerializationError(error)) {
      return this.build(500, "internal_error", "The server produced an invalid response.", instance);
    }
    const status = ProblemMapper.clientErrorStatus(error);
    if (status !== null) {
      return this.build(status, ProblemMapper.slug(status), (error as Error).message, instance);
    }
    return this.build(500, "internal_error", "An unexpected error occurred.", instance);
  }

  /** The problem for a path that matches no route. */
  public notFound(instance: string): Problem {
    return this.build(404, "route_not_found", "No such endpoint.", instance);
  }

  private build(
    status: number,
    code: string,
    detail: string,
    instance: string,
    extra: { errors?: readonly ProblemFieldError[] } = {},
  ): Problem {
    return {
      type: `urn:render-queue:problem:${code.replaceAll("_", "-")}`,
      title: STATUS_CODES[status] ?? "Error",
      status,
      detail,
      instance,
      code,
      ...extra,
    };
  }

  private static clientErrorStatus(error: unknown): number | null {
    if (typeof error !== "object" || error === null || !("statusCode" in error)) {
      return null;
    }
    const status = error.statusCode;
    return typeof status === "number" && status >= 400 && status < 500 ? status : null;
  }

  private static slug(status: number): string {
    return (STATUS_CODES[status] ?? "error").toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");
  }
}
