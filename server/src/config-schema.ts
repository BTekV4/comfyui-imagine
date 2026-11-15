/**
 * The boot checks of `config.yaml`: a few typed validators, enough for the
 * two plugin configs (ComfyUI connection, Imagine workflows) that schemastery
 * used to check.
 *
 * Same semantics as the schemastery calls they replace, so a config that
 * booted before boots now and a wrong one fails with the field's path:
 * - an absent value passes, unless the check is `required`;
 * - an absent object is checked as `{}`, so every declared sub-object exists
 *   in the result (the loader relies on it: an entry without a `path` is one
 *   the deployment did not configure), and an absent list is `[]`;
 * - keys an object does not declare are kept as they are.
 * No defaults beyond those two: the consumers apply their own.
 * @module config-schema
 */

/** A check: the value as accepted, or a throw naming where it failed. */
export type Check = (value: unknown, path: string) => unknown

/** A config value that does not have the declared shape. */
export class ConfigError extends Error {}

const fail = (path: string, expected: string, value: unknown): never => {
  throw new ConfigError(`${path}: expected ${expected} but got ${JSON.stringify(value)}`)
}

/** What a check does with a missing value. */
interface Presence {
  /** Fail instead of passing an absent value. */
  readonly required?: boolean
}

/**
 * A string.
 * @param options - `min`: the shortest length accepted.
 */
export function string(options: Presence & { readonly min?: number } = {}): Check {
  return (value, path) => {
    if (value === undefined || value === null) return absent(options, value, path)
    if (typeof value !== 'string') return fail(path, 'string', value)
    if (options.min !== undefined && value.length < options.min) return fail(path, `string length >= ${String(options.min)}`, value)
    return value
  }
}

/**
 * A number.
 * @param options - bounds, and `integer` for a whole number.
 */
export function number(options: Presence & { readonly min?: number; readonly max?: number; readonly integer?: boolean } = {}): Check {
  return (value, path) => {
    if (value === undefined || value === null) return absent(options, value, path)
    if (typeof value !== 'number' || Number.isNaN(value)) return fail(path, 'number', value)
    if (options.max !== undefined && value > options.max) return fail(path, `number <= ${String(options.max)}`, value)
    if (options.min !== undefined && value < options.min) return fail(path, `number >= ${String(options.min)}`, value)
    if (options.integer === true && !Number.isInteger(value)) return fail(path, 'integer', value)
    return value
  }
}

/** A boolean. */
export function boolean(options: Presence = {}): Check {
  return (value, path) => {
    if (value === undefined || value === null) return absent(options, value, path)
    return typeof value === 'boolean' ? value : fail(path, 'boolean', value)
  }
}

/**
 * One of a fixed set of strings.
 * @param values - the accepted spellings.
 */
export function oneOf(values: readonly string[], options: Presence = {}): Check {
  return (value, path) => {
    if (value === undefined || value === null) return absent(options, value, path)
    return typeof value === 'string' && values.includes(value) ? value : fail(path, values.join(' | '), value)
  }
}

/**
 * A list, each item checked by `item`; absent, the empty list.
 * @param item - the check of one item.
 */
export function list(item: Check, options: Presence = {}): Check {
  return (value, path) => {
    if (value === undefined || value === null) {
      if (options.required === true) return fail(path, 'list', value)
      return []
    }
    if (!Array.isArray(value)) return fail(path, 'list', value)
    return value.map((entry, index) => item(entry, `${path}[${String(index)}]`))
  }
}

/**
 * An object with the declared members; absent, checked as `{}` unless
 * `optional`, in which case it stays absent.
 * @param shape - the check of each declared member.
 * @param options - `optional`: leave an absent object absent.
 */
export function object(
  shape: Readonly<Record<string, Check>>,
  options: Presence & { readonly optional?: boolean } = {},
): Check {
  return (value, path) => {
    if (value === undefined || value === null) {
      if (options.required === true) return fail(path, 'object', value)
      if (options.optional === true) return value
      value = {}
    }
    if (typeof value !== 'object' || Array.isArray(value)) return fail(path, 'object', value)
    const source = value as Record<string, unknown>
    // Undeclared keys pass through untouched, as schemastery's did.
    const result: Record<string, unknown> = { ...source }
    for (const [key, check] of Object.entries(shape)) {
      const checked = check(source[key], `${path}.${key}`)
      if (checked !== undefined && checked !== null) result[key] = checked
      else if (!(key in source)) delete result[key]
    }
    return result
  }
}

/** An absent value: refused when required, passed through otherwise. */
function absent(options: Presence, value: unknown, path: string): unknown {
  return options.required === true ? fail(path, 'a value', value) : value
}
