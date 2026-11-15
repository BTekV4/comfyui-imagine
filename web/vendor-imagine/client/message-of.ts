/**
 * The text of an unknown failure: an Error's message, anything else as a
 * string: the one spelling of `x instanceof Error ? x.message : String(x)`.
 * @module client/message-of
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
