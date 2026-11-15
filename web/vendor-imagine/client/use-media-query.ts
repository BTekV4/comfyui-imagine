/**
 * A media query as a value that follows the window.
 *
 * The board read its breakpoint once per call (`isWideLayout`) and the page
 * kept a second listener of its own for the rail's: two ways of asking the
 * same thing, one of them not reactive.
 * @module use-media-query
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react'

/**
 * Width below which the rail is a drawer rather than a column. The rail holds
 * real width — 256px of it — which is why it goes first and at a width the
 * chat is still comfortable at. Mirrors the `max-width: 900px` blocks in the
 * CSS modules (Rail, StageHeader, ChatColumn); they must move together.
 */
export const NARROW_RAIL_QUERY = '(max-width: 900px)'

/**
 * Width below which the project view stacks the chat above the canvas instead
 * of floating it over one edge: a phone. Mirrors the `max-width: 640px`
 * blocks of the CSS modules.
 */
export const STACKED_QUERY = '(max-width: 640px)'

/**
 * Whether a media query matches, re-rendering when that changes.
 * @param query - the media query.
 * @param fallback - the answer where it cannot be evaluated.
 * @returns whether it matches now.
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const list = useMemo(
    () => (typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(query) : undefined),
    [query],
  )
  const subscribe = useCallback((listener: () => void) => {
    list?.addEventListener('change', listener)
    return () => { list?.removeEventListener('change', listener) }
  }, [list])
  const read = useCallback(() => list?.matches ?? fallback, [list, fallback])
  return useSyncExternalStore(subscribe, read, read)
}
