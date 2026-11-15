/**
 * The shared studio (GET/PUT /comfy-imagine/projects): projects, their chat
 * lines and canvas notes, as the page writes them and the server keeps them.
 *
 * Until 2026-10-25 the page and the server each declared these, and the
 * server keeps only the fields it knows: `thinking`, added on the page alone,
 * was dropped at every save. The server's `sanitize*` now return these types,
 * so a field added here and not read there is a compile error rather than a
 * silent loss. Types only, plus a few constants; read by both sides.
 */

import type { MediaFileRef } from './imagine-types.ts'

/** Reserved id for the catch-all history project. */
export const HISTORY_PROJECT_ID = 'storico'

/**
 * Id prefix of the bookkeeping line the page writes into a fresh project (the
 * project's own title, `m-seed-<project id>`): not something anyone said
 * about the project. Shared so the Instagram plugin can skip it too.
 */
export const SEED_MESSAGE_PREFIX = 'm-seed-'

/** Longest thinking trace kept with an answer, in characters. */
export const MAX_THINKING_CHARS = 20_000

/**
 * One chat line in a project column.
 *
 * `assistant` is the studio answering in words — what it understood, or what
 * it needs before it can run anything. It is not a status: a status line
 * belongs to a job and is spoken once per job id, while an answer belongs to
 * the turn that asked for it.
 */
export interface ImagineMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'status'
  readonly text: string
  readonly createdAt: number
  readonly jobId?: string
  /**
   * The files the line was sent with.
   *
   * A photo staged and written about left the column as bare text once the
   * composer emptied: "rifai questa in 9:16" with nothing beside it reads as
   * a line with no context, and it had one.
   */
  readonly files?: readonly MediaFileRef[]
  /**
   * What the model thought before it answered, kept with the answer (at most
   * {@link MAX_THINKING_CHARS}).
   *
   * The trace used to vanish when the reading ended; the user wants it there
   * to look back at, folded (2026-09-10).
   */
  readonly thinking?: string
  /**
   * The runs this line queued, oldest first.
   *
   * The results belong to the sentence that asked for them: the column draws
   * their files under the prose, the way Grok Imagine does, instead of leaving
   * them in status lines that read as a separate receipt. Empty on a line that
   * queued nothing, and on every line written before this existed.
   */
  readonly jobIds?: readonly string[]
}

/** One text note on a project's canvas ("Testo", as Grok's canvas has), in world coordinates. */
export interface CanvasNote {
  readonly id: string
  readonly text: string
  readonly x: number
  readonly y: number
  /** Width in world pixels; the height follows the text. */
  readonly w: number
  /** Font size in world pixels. */
  readonly size: number
  /** Text colour (#RRGGBB); absent follows the theme. */
  readonly color?: string
  readonly align?: 'left' | 'center' | 'right'
}

/** One user project listed in the Imagine rail. */
export interface ImagineProject {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly itemNames: readonly string[]
  readonly jobIds: readonly string[]
  readonly messages: readonly ImagineMessage[]
  /** The prompt an old project was seeded from; kept by the server, unread by the page. */
  readonly seedPrompt?: string
  readonly pinned?: boolean
  /** The file the project card shows first ("Imposta come copertina"). */
  readonly cover?: string
  /**
   * True while the title is still the placeholder the studio chose on its own
   * (an untitled number, a card label, a truncated first line). The first
   * content then asks the reading model for a real name, and a name the user
   * typed in the rename field finalises it immediately.
   *
   * Absent on projects written before the naming existed: their title is
   * already whatever it is, and renaming them under the user would be worse
   * than leaving them.
   */
  readonly autoTitle?: boolean
  /** Text notes on the canvas. */
  readonly notes?: readonly CanvasNote[]
}

/** One saved canvas tile. */
export interface CanvasRect {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** Size against the column width, set by resizing the tile (0.75–3). */
  readonly scale?: number
}

/** Per project, the file names and job ids taken out of it, with when. */
export type ImagineRemovals = Readonly<Record<string, Readonly<Record<string, number>>>>
