/** Source of the current time. */
export interface Clock {
  now(): Date;
}

/** Source of fresh identifiers. */
export interface IdGenerator {
  next(): string;
}

/** Structured logging; compatible with pino's call shape. */
export interface Logger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/** A named dependency probe used by the readiness endpoint. */
export interface HealthCheck {
  readonly name: string;
  check(): Promise<void>;
}

/** A scratch directory for one job. */
export interface Workspace {
  pathFor(name: string): string;
  dispose(): Promise<void>;
}

/** Creates scratch directories. */
export interface WorkspaceProvider {
  create(): Promise<Workspace>;
}
