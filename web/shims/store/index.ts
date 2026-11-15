/**
 * The studio's one store: a state, a table of immer-draft actions that are
 * the only way to change it, and optional debounced persistence to
 * localStorage. Vendored from DSH's client-store, cut down to what Imagine
 * uses — one instance, read through `useSyncExternalStore` (web/src/main.tsx).
 */
import { freeze, produce } from 'immer'

/* oxlint-disable-next-line typescript/no-explicit-any --
 * any[] (not unknown[]): each action carries its own parameter list, and
 * unknown[] would reject every concrete signature under strict parameter
 * contravariance. Params are re-inferred per action by BakedActions. */
export type ActionsDecl<T> = Record<string, (draft: T, ...params: any[]) => void>

/** The actions as callers see them: the draft parameter baked away. */
export type BakedActions<T, A extends ActionsDecl<T>> = {
  [K in keyof A]: A[K] extends (draft: T, ...params: infer P) => void ? (...params: P) => void : never
}

/** Initial-state factory, optional persistence key, and the full write set. */
export interface StoreSpec<T, A extends ActionsDecl<T>> {
  init: () => T
  persist?: string
  actions: A
}

/** A live store: its snapshot, its subscribers and its actions. */
export interface StoreInstance<T, A extends ActionsDecl<T>> {
  readonly actions: BakedActions<T, A>
  getSnapshot(): T
  /**
   * Subscribe to state changes; every change is heard in the same tick
   * (controlled inputs need the same-tick echo).
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(fn: () => void): () => void
}

/** How long the store must stay still before it is written to localStorage. */
const PERSIST_DEBOUNCE_MS = 400

/** Deep-freeze state outside production: a wholesale load bypasses immer's freeze. */
function devFreeze<T>(value: T): T {
  if (process.env.NODE_ENV === 'production') return value
  return freeze(value, true)
}

/**
 * Whole-value JSON persistence. Storage failures (quota, private mode) only
 * disable persistence, never break the store.
 * @param name - the localStorage key.
 * @param read - the current state.
 * @returns what to call after every change.
 */
function persistence<T>(name: string, read: () => T): () => void {
  if (typeof localStorage === 'undefined') return () => undefined
  /*
   * One write per quiet spell, not per action: the Imagine store carries the
   * projects (~600 KB), and dragging a column fired an action — and a whole
   * synchronous stringify + setItem — on every pointermove (2026-10-20).
   * Leaving the page writes at once, so a pending change is not lost.
   */
  let timer: ReturnType<typeof setTimeout> | undefined
  const write = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    try {
      localStorage.setItem(name, JSON.stringify(read()))
    } catch (error) {
      console.error(`snapshot store '${name}' persistence failed:`, error)
    }
  }
  if (typeof window !== 'undefined') {
    const flush = (): void => { if (timer !== undefined) write() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush() })
  }
  return () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(write, PERSIST_DEBOUNCE_MS)
  }
}

/** The state a persisted store starts from, or undefined when there is none. */
function rehydrate<T>(name: string): T | undefined {
  if (typeof localStorage === 'undefined') return undefined
  try {
    const raw = localStorage.getItem(name)
    return raw === null ? undefined : JSON.parse(raw) as T
  } catch (error) {
    console.error(`snapshot store '${name}' rehydration failed:`, error)
    return undefined
  }
}

/**
 * Make the store, seeded from localStorage when the spec persists and there
 * is a stored copy, from `spec.init()` otherwise.
 *
 * DSH declared a store once and made scoped instances of it; the studio has
 * one store and one instance, so declaring and making are one step here.
 *
 * The `A & ActionsDecl<T>` actions position is load-bearing: T resolves from
 * `init` first, and the intersection then contextually types each mutator's
 * draft parameter, so call sites write `(d, x: X) => { ... }` with no draft
 * annotation.
 * @param spec - init lambda, optional persist key, actions table.
 * @returns the live store.
 */
export function createStore<T, A extends ActionsDecl<T>>(
  spec: StoreSpec<T, A> & { actions: A & ActionsDecl<T> }): StoreInstance<T, A> {
  const stored = spec.persist === undefined ? undefined : rehydrate<T>(spec.persist)
  let state = devFreeze(stored ?? spec.init())
  const listeners = new Set<() => void>()
  const changed = spec.persist === undefined ? () => undefined : persistence(spec.persist, () => state)
  const actions = {} as Record<string, (...params: unknown[]) => void>
  for (const key of Object.keys(spec.actions)) {
    const mutate = spec.actions[key] as (draft: T, ...params: unknown[]) => void
    actions[key] = (...params: unknown[]) => {
      // produce also freezes outside production.
      const next = produce(state, (draft) => { mutate(draft as T, ...params) })
      if (Object.is(next, state)) return
      state = next
      changed()
      // One failing subscriber does not starve the rest.
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[client-store] subscriber failed:', error)
        }
      }
    }
  }
  return {
    actions: actions as BakedActions<T, A>,
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}
