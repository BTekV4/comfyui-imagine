/**
 * Reading a model's reply: the fence, the preamble and the JSON inside.
 *
 * Six modules carried their own copy of these few lines (2026-10-20).
 * @module tool-comfy/model-json
 */

import { isPlainObject } from './guards.ts'

/**
 * Drop the Markdown code fences a model wraps its answer in.
 * @param text - the raw reply.
 * @returns the reply without ``` lines.
 */
export function stripFences(text: string): string {
  return text.replaceAll(/```[a-z]*\n?/gi, '')
}

/**
 * The body of the first fenced block of a reply, when it has one.
 * @param text - the raw reply.
 * @returns what sits between the first pair of ``` fences, or undefined.
 */
export function fencedBody(text: string): string | undefined {
  return /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
}

/**
 * Pull the JSON object out of a reply that may carry a fence or a preamble.
 * @param text - the raw reply.
 * @returns the object, or undefined when there is none or it does not parse.
 */
export function jsonObjectOf(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  const body = fencedBody(text) ?? text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const value = JSON.parse(body.slice(start, end + 1)) as unknown
    return isPlainObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The last line of a probe's output that is a JSON object.
 *
 * The lipsync probe prints one JSON line last, after whatever its libraries
 * print; the probe readers used to carry these lines.
 * @param stdout - everything the probe wrote.
 * @returns the object, or undefined when no line parses as one.
 */
export function lastJsonLine(stdout: string): Record<string, unknown> | undefined {
  const line = stdout.trim().split('\n').reverse().find(entry => entry.trim().startsWith('{'))
  if (line === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(line)
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * One labelled value of a reply written as `label: value` lines.
 *
 * Without `next` the value is the rest of the label's line (or the next line,
 * when the label stands alone on its own); with `next` it runs to the start of
 * that label, and with `null` to the end of the text.
 * @param text - the reply.
 * @param label - the label to read, matched case-insensitively at a line start.
 * @param next - the label that ends a multi-line value, or null for the end of the text.
 * @returns the value, trimmed, or undefined when the label is missing or empty.
 */
export function labelledValue(text: string, label: string, next?: string | null): string | undefined {
  const found = new RegExp(`^\\s*${label}\\s*:`, 'im').exec(text)
  if (found === null) return undefined
  const rest = text.slice(found.index + found[0].length)
  let value: string
  if (next === undefined) {
    const body = rest.replace(/^\s+/, '')
    value = body.slice(0, /\n|$/.exec(body)?.index ?? body.length)
  } else {
    const stop = next === null ? null : new RegExp(`^\\s*${next}\\s*:`, 'im').exec(rest)
    value = rest.slice(0, stop === null ? rest.length : stop.index)
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Take the markdown decoration off a reply before reading its labels.
 *
 * Asked for plain labelled lines the model still answers `**reference:**` often
 * enough to matter, and a label wearing two asterisks reads as no label at all:
 * the whole pass then falls back to the graph's placeholders, which is how the
 * first real chain rendered a clip with a prompt about nothing (2026-10-15).
 * @param text - the raw reply.
 * @returns the reply with emphasis and heading marks removed.
 */
export function withoutMarkdown(text: string): string {
  return text
    .replaceAll(/\*\*/g, '')
    .replaceAll(/(^|\n)\s*#{1,6}\s*/g, '$1')
    .replaceAll(/(^|\n)\s*[-*]\s+(?=[a-z_]+\s*:)/gi, '$1')
}

/**
 * The lighter cleaning «Recreate video» reads its reply with: only the marks at
 * the start of each line (quote, heading, emphasis), so a bold label still
 * reads as a label while the text after it — which Krea 2 is given as it is —
 * keeps everything else the model wrote.
 * @param text - the raw reply.
 * @returns the reply without line-leading markdown marks.
 */
export function withoutLineMarks(text: string): string {
  return text.replaceAll(/^[\s>#*]+/gm, '')
}
