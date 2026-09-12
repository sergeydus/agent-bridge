/**
 * The shared vocabulary for runtime validators.
 *
 * Every persisted and provider-facing format is validated at its boundary
 * rather than trusted, and each of those validators needs the same few
 * predicates. Keeping one definition means a checkpoint, a chat session, a
 * project configuration, and a provider response all agree on what "an object",
 * "no unexpected keys", and "a timestamp" mean. Copies of these drifted apart
 * silently, because a weakened predicate still typechecks everywhere.
 */

/**
 * A plain object. Arrays are excluded: `typeof [] === 'object'`, and every
 * caller here is checking for a record with named fields.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Rejects unexpected keys. Validators are allow-lists so an old or hand-edited
 * file cannot smuggle fields past a check that only looks at the ones it knows.
 */
export function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/**
 * An ISO 8601 timestamp that survives a round trip. Comparing against
 * `toISOString()` rejects the many strings `Date.parse` accepts but does not
 * reproduce, so a stored timestamp always means exactly one instant.
 */
export function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value
  );
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}
