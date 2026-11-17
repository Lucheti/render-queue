/** Category of a domain failure; transport layers map it to their own status model. */
export type ErrorKind = "validation" | "not_found" | "conflict" | "unavailable";

/** Base class for every error the domain and application layers raise on purpose. */
export class DomainError extends Error {
  public readonly kind: ErrorKind;
  public readonly code: string;

  public constructor(kind: ErrorKind, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.kind = kind;
    this.code = code;
  }
}

/** The caller supplied something the rules reject. */
export class ValidationError extends DomainError {
  public constructor(code: string, message: string) {
    super("validation", code, message);
  }
}

/** The referenced entity does not exist. */
export class NotFoundError extends DomainError {
  public constructor(code: string, message: string) {
    super("not_found", code, message);
  }
}

/** The request is valid but clashes with the current state of the entity. */
export class ConflictError extends DomainError {
  public constructor(code: string, message: string) {
    super("conflict", code, message);
  }
}

/** A dependency needed to serve the request is not available. */
export class UnavailableError extends DomainError {
  public constructor(code: string, message: string, options?: ErrorOptions) {
    super("unavailable", code, message, options);
  }
}
