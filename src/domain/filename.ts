import { ValidationError } from "./errors.js";

const MAX_LENGTH = 255;
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f/\\]/;

/** A display file name: non-blank, at most 255 characters, no path separators or control characters. */
export class Filename {
  private constructor(private readonly value: string) {}

  /** Validates and trims a client-supplied file name. */
  public static of(raw: string): Filename {
    const value = raw.trim();
    if (value.length === 0 || value.length > MAX_LENGTH) {
      throw new ValidationError("invalid_filename", `Filename must be 1-${MAX_LENGTH} characters.`);
    }
    if (FORBIDDEN.test(value) || value === "." || value === "..") {
      throw new ValidationError("invalid_filename", "Filename must not contain path separators or control characters.");
    }
    return new Filename(value);
  }

  /** The validated name. */
  public toString(): string {
    return this.value;
  }
}
