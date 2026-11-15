/**
 * The small type guards the host reads untrusted values with.
 *
 * Every one of them was written out at least twice before 2026-10-22: the
 * same `typeof value === 'object' && …` in three files, the same trimmed
 * string in two. A guard that drifts from its twin is how a settings file
 * stops validating the same way in the page and in the host.
 * @module tool-comfy/guards
 */

/**
 * Whether a value is a plain data object rather than an array or a scalar.
 * @param value - the value to check.
 * @returns true for an object that is not `null` and not an array.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A finite number, or undefined.
 * @param value - the value to check.
 * @returns the number when it is finite.
 */
export function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * A string field of an untrusted object, trimmed, or undefined when absent or
 * empty.
 * @param source - the object to read.
 * @param key - the field name.
 * @returns the trimmed text, or undefined.
 */
export function textField(source: Record<string, unknown>, key: string): string | undefined {
  return trimmedText(source[key])
}

/**
 * The same, for a value already in hand.
 * @param value - the value to check.
 * @returns the trimmed text, or undefined when it is not usable.
 */
export function trimmedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}
