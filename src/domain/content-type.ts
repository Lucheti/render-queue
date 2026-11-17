import { ValidationError } from "./errors.js";

const TOKEN = "[a-z0-9][a-z0-9!#$&^_.+-]*";
const MEDIA_TYPE = new RegExp(`^(${TOKEN})/(${TOKEN})$`);

/** A bare MIME type (no parameters), normalised to lower case. */
export class ContentType {
  private constructor(
    private readonly top: string,
    private readonly sub: string,
  ) {}

  /** Parses any well-formed MIME type. */
  public static of(raw: string): ContentType {
    const match = MEDIA_TYPE.exec(raw.trim().toLowerCase());
    const top = match?.[1];
    const sub = match?.[2];
    if (top === undefined || sub === undefined) {
      throw new ValidationError("invalid_content_type", `"${raw}" is not a valid media type.`);
    }
    return new ContentType(top, sub);
  }

  /** Parses a MIME type and accepts it only when it is `video/*`. */
  public static video(raw: string): ContentType {
    const parsed = ContentType.of(raw);
    if (parsed.top !== "video") {
      throw new ValidationError(
        "unsupported_content_type",
        `Only video/* uploads are accepted, got "${parsed.toString()}".`,
      );
    }
    return parsed;
  }

  /** The canonical `type/subtype` string. */
  public toString(): string {
    return `${this.top}/${this.sub}`;
  }
}
