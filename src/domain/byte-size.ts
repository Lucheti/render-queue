import { ValidationError } from "./errors.js";

/** A positive number of bytes that can be bounded by a limit. */
export class ByteSize {
  private constructor(private readonly bytes: number) {}

  /** Builds a size, rejecting non-positive or non-integer values and anything above `limit`. */
  public static of(bytes: number, limit?: ByteSize): ByteSize {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new ValidationError("invalid_size", "Size must be a positive whole number of bytes.");
    }
    if (limit !== undefined && bytes > limit.bytes) {
      throw new ValidationError(
        "size_limit_exceeded",
        `Size ${bytes} bytes exceeds the limit of ${limit.bytes} bytes.`,
      );
    }
    return new ByteSize(bytes);
  }

  /** The size as a plain number of bytes. */
  public toNumber(): number {
    return this.bytes;
  }
}
