/**
 * A handler whose identity never changes and that always runs the latest
 * function it was given.
 *
 * The studio passes its handlers down to memoized pieces (the board, the
 * rail, the chat column, the tiles); a fresh closure per render broke every
 * one of those memos. This is the ref pattern the page already used for the
 * tiles, written once.
 * @module use-event
 */

import { useCallback, useRef } from 'react'

/**
 * @param handler - the function as of this render.
 * @returns a stable function that calls it.
 */
export function useEvent<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
  const latest = useRef(handler)
  latest.current = handler
  return useCallback((...args: A) => latest.current(...args), [])
}
