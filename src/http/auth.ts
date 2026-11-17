import { createHash, timingSafeEqual } from "node:crypto";

/** Checks the `x-api-key` header against the configured key in constant time. */
export class ApiKeyAuthenticator {
  private readonly expected: Buffer;

  public constructor(apiKey: string) {
    this.expected = ApiKeyAuthenticator.digest(apiKey);
  }

  /** Both sides are hashed first so the comparison always sees equal-length buffers and leaks no length. */
  public verify(candidate: string | undefined): boolean {
    return timingSafeEqual(ApiKeyAuthenticator.digest(candidate ?? ""), this.expected) && candidate !== undefined;
  }

  private static digest(value: string): Buffer {
    return createHash("sha256").update(value).digest();
  }
}
