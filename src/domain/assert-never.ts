/** Compile-time proof that a `switch` handled every member of a union. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
