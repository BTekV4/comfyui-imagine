/**
 * What ComfyUI said when it refused a graph, read out of the failure text.
 *
 * A rejected run reaches the studio as `ComfyUI rejected the workflow: {...}`,
 * and inside that body is a `node_errors` map naming the node, the input and
 * the value it would not take. The studio used to drop all of it for one
 * sentence that said only that something had failed, which left the chat
 * unable to answer "why did it fail?" — and the answer is almost always a
 * closed-list value the graph does not have (a pose, a look, a checkpoint),
 * which is exactly what tells the user what to write instead.
 *
 * Parsing lives here, apart from the page, because it is the one part of that
 * sentence that has nothing to do with the locale: what it returns is fields,
 * and the page turns them into words.
 */

/** One input a node refused, in the terms ComfyUI reported it. */
export interface RefusedInput {
  /** The node id in the API-format graph. */
  readonly node: string
  /** Its `class_type`, which is what the user sees in ComfyUI. */
  readonly kind: string
  /** The input's name on that node. */
  readonly field: string
  /** The value it was given, when ComfyUI echoed one back. */
  readonly value?: string
  /** True when the input is a closed list and the value was not on it. */
  readonly notInList: boolean
  /** ComfyUI's own one-line reason. */
  readonly reason: string
}

/** A string or a number the graph was given, as text; anything else is not a value to quote. */
function quoted(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

/**
 * Read the refused inputs out of a failed run's error text.
 * @param raw - the message the run failed with.
 * @returns one entry per refused input, empty when this is not a node rejection.
 */
export function refusedInputs(raw: string): readonly RefusedInput[] {
  const start = raw.indexOf('{')
  if (start < 0) return []
  let body: unknown
  try {
    body = JSON.parse(raw.slice(start))
  }
  catch {
    // Not every failure carries a body: a timeout, an unreachable host and the
    // studio's own refusals are plain sentences, and they are not rejections.
    return []
  }
  const errors = (body as { node_errors?: unknown }).node_errors
  if (typeof errors !== 'object' || errors === null) return []
  const found: RefusedInput[] = []
  for (const [node, value] of Object.entries(errors as Record<string, unknown>)) {
    const entry = value as { errors?: unknown; class_type?: unknown }
    const kind = typeof entry.class_type === 'string' ? entry.class_type : '?'
    for (const item of Array.isArray(entry.errors) ? entry.errors : []) {
      const fault = item as { type?: unknown; message?: unknown; extra_info?: unknown }
      const extra = (typeof fault.extra_info === 'object' && fault.extra_info !== null
        ? fault.extra_info
        : {}) as { input_name?: unknown; received_value?: unknown }
      const given = quoted(extra.received_value)
      found.push({
        node,
        kind,
        field: typeof extra.input_name === 'string' ? extra.input_name : '?',
        ...given === undefined ? {} : { value: given },
        notInList: fault.type === 'value_not_in_list' && given !== undefined,
        reason: typeof fault.message === 'string' ? fault.message : '?',
      })
    }
  }
  return found
}
