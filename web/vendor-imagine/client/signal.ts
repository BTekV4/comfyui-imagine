/**
 * One value the page keeps outside React, and a hook that reads a part of it.
 *
 * The composer, the reading trace and the board camera each wrote the same
 * thing by hand: a variable, a set of listeners, `get`/`set`/`subscribe`, and
 * a `useSyncExternalStore` wrapper with a selector. They now build on this,
 * and keep only what is their own (how a patch is applied, the zoom clamp).
 * @module signal
 */

import { useSyncExternalStore } from 'react'

/** Anything a component can subscribe to and read. */
export interface Readable<T> {
  get(): T
  subscribe(listener: () => void): () => void
}

/** A value with listeners. */
export interface Signal<T> extends Readable<T> {
  /** Replace the value; the listeners are told only when it is another value (`Object.is`). */
  set(next: T): void
}

/**
 * A value with listeners.
 * @param initial - the first value.
 * @returns the signal.
 */
export function createSignal<T>(initial: T): Signal<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return
      value = next
      // A copy: a listener may unsubscribe while being told.
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * One reading of a store, re-rendering only when it changes.
 * @param store - the store; its `subscribe` must keep its identity.
 * @param select - what to read; it must return a stored value or a primitive.
 * @returns the selected value.
 */
export function useSelected<S, T>(store: Readable<S>, select: (state: S) => T): T {
  const read = (): T => select(store.get())
  return useSyncExternalStore(store.subscribe, read, read)
}
