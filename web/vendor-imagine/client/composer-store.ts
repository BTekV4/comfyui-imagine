/**
 * What the composer and the workflow panels hold, outside the page's state.
 *
 * Every key typed in the composer used to set state in the page and draw the
 * rail, the chat column and the board again. The fields live here: the
 * composer and the panel read them, and the page reads them when it acts — at
 * send time, never while rendering.
 * @module composer-store
 */

import { useSyncExternalStore } from 'react'
import type { ImagineAspect, ImagineResolution } from '../../../shared/imagine-media.ts'
import {
  DEFAULT_OBJECT_PLACEMENT, type GalleryItem, type ImagineObjectMode, type ImaginePlacement, type ImagineQuality,
  type ImagineSpeed, type ModelRoute,
} from '../../../shared/imagine-types.ts'
import type { ImagineMode } from './imagine-settings.ts'
import { DEFAULT_RELIGHT_LOOK } from '../../../shared/relight-looks.ts'

/** The composer's fields, and the panels' options that travel with a run. */
export interface ComposerState {
  readonly prompt: string
  readonly mode: ImagineMode
  readonly aspect: ImagineAspect
  readonly resolution: ImagineResolution
  /*
   * Ten seconds is the clip the studio is asked for: the five-second one was
   * the ladder's first rung, not the answer anybody wanted, and it cost a
   * second run every time.
   */
  readonly seconds: number
  /** Sung words for MiniMax Music 3; empty asks for an instrumental. */
  readonly lyrics: string
  /*
   * "Recreate video" and the soundtrack of the clip it recreates. On by default:
   * a recreation of something that was filmed usually keeps what it sounds
   * like, and the switch is one click away when it does not.
   */
  readonly keepAudio: boolean
  /* "Character swap": on by default, the new person follows the clip's vocals. */
  readonly lipSync: boolean
  /*
   * "Speed", for the clips: `fast` is the graph as it ships (the 4-step Pika
   * recipe since 2026-11-05), `slow` the second graph the workflow declares as
   * `pathHigh` — the official 6-step Pika graph (2026-11-03, the pill Grok has
   * next to the composer).
   */
  readonly speed: ImagineSpeed
  /*
   * "Quality", for the photos: `standard` leaves the graph at the step count it
   * was saved with, `high` draws at the workflow's `steps.high` — sixteen on
   * the Krea 2 graphs. Same mechanism as `speed`, on the other kind of media.
   */
  readonly quality: ImagineQuality
  /**
   * How many opening frames a "Recreate video" scan draws: a take costs ~20 s,
   * so the count is a straight tradeoff between waiting and choice. It travels
   * with the request (`candidates`), never as `count`, which queues a batch.
   */
  readonly frameCandidates: number
  /**
   * "Light the photo": the chosen lighting look, by id (`shared/relight-looks`).
   *
   * The look IS the prompt: the panel has no text field, and the run sends
   * this id instead of a sentence.
   */
  readonly light: string
  /**
   * "Object swap": what to do with the object tracked in the clip.
   *
   * `change` is the mode that carries the photo; the sentence describes the
   * other three. It lives here and not in the panel because the panel closes
   * on Send and the run reads the fields at click time.
   */
  readonly objectMode: ImagineObjectMode
  /**
   * "Object swap" → "Add an object": where the new object appears, as
   * fractions of the frame. The panel picks it with a 3×3 grid and a size;
   * with no choice the centre applies (2026-11-06).
   */
  readonly placement: ImaginePlacement
  /**
   * The starting files, not one. Picking a single tile still replaces the
   * whole staging, but "make video" on a multiple selection puts every still
   * in here, so the prompt and the video controls are chosen once for all of
   * them instead of being asked for per file.
   */
  readonly sources: readonly GalleryItem[]
  /** The line under the composer (and the panel): what is missing, what failed. */
  readonly note: string | undefined
  /** The step picked in the Upscale panel, by short side. */
  readonly panelUpscaleTo: number | undefined
  /*
   * The route the model chip is showing. It reaches the reading, so the model
   * the user picked is the one that answers in the column.
   */
  readonly chatModel: ModelRoute | undefined
}

/** The composer's fields as a page opens. */
const INITIAL: ComposerState = {
  prompt: '',
  mode: 'image',
  aspect: '9:16',
  resolution: '1080p',
  seconds: 10,
  lyrics: '',
  keepAudio: true,
  lipSync: true,
  speed: 'fast',
  quality: 'standard',
  frameCandidates: 4,
  objectMode: 'change',
  placement: DEFAULT_OBJECT_PLACEMENT,
  light: DEFAULT_RELIGHT_LOOK.id,
  sources: [],
  note: undefined,
  panelUpscaleTo: undefined,
  chatModel: undefined,
}

/** A change to some of the fields, or a function of the current ones. */
export type ComposerPatch = Partial<ComposerState> | ((state: ComposerState) => Partial<ComposerState>)

export interface ComposerStore {
  get(): ComposerState
  /** Apply a change; nothing is told when no field actually changes. */
  set(patch: ComposerPatch): void
  subscribe(listener: () => void): () => void
}

/**
 * A composer with nothing in it.
 * @returns the store the page keeps for its life.
 */
export function createComposerStore(): ComposerStore {
  let state = INITIAL
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: (patch) => {
      const next = typeof patch === 'function' ? patch(state) : patch
      const changed = (Object.keys(next) as (keyof ComposerState)[]).some(key => next[key] !== state[key])
      if (!changed) return
      state = { ...state, ...next }
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * One field (or a value worked out from them), re-rendering only when it changes.
 * @param store - the page's composer.
 * @param select - what to read; it must return a stored value or a primitive.
 * @returns the selected value.
 */
export function useComposer<T>(store: ComposerStore, select: (state: ComposerState) => T): T {
  const read = (): T => select(store.get())
  return useSyncExternalStore(store.subscribe, read, read)
}
