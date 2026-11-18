/**
 * What `/api/file-details` says about one file: how it was made, with which
 * words, from which file. Read by the "Details" card and by the line under
 * the viewer, which used to keep a type and a list of placeholder prompts
 * each — and the two lists had drifted apart.
 */
import { getJson } from './http.ts'
import type { MediaKind } from '../../../shared/imagine-types.ts'
import { ACTION_TABLE } from '../../../shared/imagine-action-table.ts'

/** The run a file came out of, as the host recorded it. */
export interface FileOrigin {
  readonly action: string
  readonly prompt: string
  readonly source?: string
  readonly aspect?: string
  readonly seconds?: number
  readonly pose?: string
  readonly resolution?: string
  readonly changes?: string
  readonly subject?: string
  readonly lipsync?: number
  /** How long the run took, in milliseconds, when the host measured it. */
  readonly tookMs?: number
  /**
   * A story's shot: the beat in the language of the page it was planned from,
   * and that language. The card shows this when it is the page's own language
   * and keeps the English text beside it, because that is what was sent.
   */
  readonly caption?: string
  readonly captionLanguage?: string
}

/** The whole answer of `/api/file-details`. */
export interface FileDetailsBody {
  readonly name: string
  readonly kind: MediaKind
  readonly size: number
  readonly mtime: number
  readonly width?: number
  readonly height?: number
  readonly duration?: number
  readonly origin?: FileOrigin
  readonly sight?: string
  readonly writtenPrompt?: string
}

/**
 * Actions that take no words: the host writes its own line for them
 * («Ritaglio 512×512», «Taglio 1.0–3.0 s», «Copia», …), which is a
 * description of the result, not a request anyone typed.
 */
const WORDLESS_ACTIONS = new Set(['bg', 'upscale', 'voice', 'crop', 'duplicate', 'erase', 'trim', 'merge', 'frame', 'addAudio'])

/**
 * Stand-in prompts a record can carry instead of words anyone typed.
 *
 * The first are what the host writes for a wordless run (`untitled` in
 * shared/imagine-action-table.ts: upscale, bg, voice, and «character swap»
 * for a promptless swapPerson), read from the same table; the last three are
 * what older records carry. Without 'character swap' a promptless swap
 * showed the host's placeholder as the user's own request.
 */
const PLACEHOLDER_PROMPTS = new Set([
  ...Object.values(ACTION_TABLE).flatMap(row => row.untitled === undefined ? [] : [row.untitled]),
  'Upscale', 'Togli lo sfondo', 'Copia',
])

/**
 * The words the user asked with, when there were any.
 * @param origin - the recorded origin.
 * @returns the request, or undefined for a wordless action.
 */
export function wordsOf(origin: FileOrigin | undefined): string | undefined {
  if (origin === undefined || WORDLESS_ACTIONS.has(origin.action) || PLACEHOLDER_PROMPTS.has(origin.prompt)) return undefined
  return origin.prompt
}

/**
 * The host's own line for a wordless action («Taglio 1.0–3.0 s»), when it
 * wrote one: it describes the result, so it is shown as such.
 * @param origin - the recorded origin.
 * @returns the line, or undefined.
 */
export function hostLineOf(origin: FileOrigin | undefined): string | undefined {
  if (origin === undefined || !WORDLESS_ACTIONS.has(origin.action) || PLACEHOLDER_PROMPTS.has(origin.prompt)) return undefined
  return origin.prompt.trim() === '' ? undefined : origin.prompt
}

/**
 * Read one file's details.
 * @param name - the gallery basename.
 * @returns the details.
 */
export async function fetchFileDetails(name: string): Promise<FileDetailsBody> {
  return await getJson<FileDetailsBody>(`/api/file-details?name=${encodeURIComponent(name)}`, 'HTTP')
}
