/**
 * What the studio did while reading one written line, outside the page's
 * state.
 *
 * Every token of the model's thinking used to be a `setThoughts` of the whole
 * page, which drew the rail, the board and the composer again for each one.
 * The trace lives here and only the chat column's box reads it whole; the
 * column itself listens to its length, to follow it down.
 * @module reading-trace
 */

import { useSyncExternalStore } from 'react'

/** One line of what the studio did while reading, already in the user's language. */
export interface ImagineThought {
  /** Stable across the trace's changes: the list's key. */
  readonly id: number
  /** A step the studio took, or the model's own thinking as it wrote it. */
  readonly kind: 'step' | 'reasoning'
  readonly text: string
  /**
   * Whether the line still says something once the reading is over.
   *
   * Which model read the sentence, that it was deciding, and that it ended
   * with N runs queued are worth watching while it happens and are noise
   * afterwards: they stayed on screen under every answer and made the studio
   * read as if it were narrating itself. Only a step that changes what the
   * user should believe about the answer — a route that had to be retried, a
   * reading that fell back — survives it.
   */
  readonly keep?: boolean
}

/** The trace of the reading in progress, or of the last one. */
export interface TraceStore {
  get(): readonly ImagineThought[]
  set(next: readonly ImagineThought[] | ((current: readonly ImagineThought[]) => readonly ImagineThought[])): void
  subscribe(listener: () => void): () => void
}

/**
 * An empty trace.
 * @returns the store the page keeps for its life.
 */
export function createTraceStore(): TraceStore {
  let thoughts: readonly ImagineThought[] = []
  const listeners = new Set<() => void>()
  return {
    get: () => thoughts,
    set: (next) => {
      const value = typeof next === 'function' ? next(thoughts) : next
      if (value === thoughts) return
      thoughts = value
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * One reading of the trace, re-rendering when it changes.
 * @param store - the page's trace.
 * @param select - what to read of it.
 * @returns the selected value.
 */
export function useTrace<T>(store: TraceStore, select: (thoughts: readonly ImagineThought[]) => T): T {
  const read = (): T => select(store.get())
  return useSyncExternalStore(store.subscribe, read, read)
}
