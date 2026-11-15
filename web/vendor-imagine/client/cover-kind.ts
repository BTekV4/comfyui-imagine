/**
 * The personal covers the client knows about, asked of the server once.
 *
 * The server knows the file (`<data>/covers/<key>.<extension>`), and every
 * surface that draws a cover needs to know it: asking for each cover's type
 * one by one would be one request per guess. The server sends the whole list
 * from `/comfy-cover-info`, once per page; this is that single request,
 * shared by every card.
 *
 * The state also carries `ready`: before the list arrives it is not known
 * whether the personal cover is an image or a video, and the card must not
 * start with the repo's clip only to replace it (on 2026-11-04 this showed
 * duplicate requests and a wrong frame for an instant).
 *
 * The decision "image or video, and with which precedence" is not here but
 * in `cover-plan.ts`, because the tests use it without React too.
 * @module cover-kind
 */

import { useSyncExternalStore } from 'react'
import type { CoverInfo, CoverInfos } from './cover-plan.ts'
import { getJson } from './http.ts'

/** The known covers, and whether the request that brings them has arrived. */
export interface CoverState {
  readonly covers: CoverInfos
  /** True once `/comfy-cover-info` has answered (even if empty). */
  readonly ready: boolean
}

let state: CoverState = { covers: {}, ready: false }
let asked: Promise<void> | undefined
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Asks for the list only once; an error is retried on the next round. */
function load(): void {
  if (asked !== undefined) return
  asked = getJson<{ covers?: Record<string, { kind?: string; ext?: string }> }>('/comfy-cover-info', 'cover').then(
    (body) => {
      const covers: Record<string, CoverInfo> = {}
      for (const [key, value] of Object.entries(body.covers ?? {})) {
        if (value.kind !== 'image' && value.kind !== 'video') continue
        covers[key] = { kind: value.kind, ext: typeof value.ext === 'string' ? value.ext : '' }
      }
      state = { covers, ready: true }
      notify()
    },
    () => {
      /*
       * An error must not leave the cards empty: the repo's covers are shown
       * (the long-standing behaviour) and the next mount retries.
       */
      asked = undefined
      if (!state.ready) {
        state = { covers: {}, ready: true }
        notify()
      }
    },
  )
}

function subscribe(listener: () => void): () => void {
  load()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function snapshot(): CoverState {
  return state
}

/**
 * The personal covers, the request that brings them, and whether it arrived.
 * @returns the covers by key, with `ready`.
 */
export function useCoverInfos(): CoverState {
  return useSyncExternalStore(subscribe, snapshot)
}
