/**
 * The long walls of files (Library, All media) draw a page at a time and only
 * the band of it near the screen: the pages added on scrolling never went
 * away, and after a long scroll thousands of cards sat in the DOM. The two
 * pages lay out differently (rows of equal cards, a masonry), so each measures
 * its own band; what they share is here: the band's size and grain, when to
 * measure, and when to add a page.
 */
import { useEffect, useRef, type RefObject } from 'react'

/** How far past the screen, above and below, cards stay drawn (px). */
const BAND_MARGIN = 1600

/** The grain the drawn band moves by, so a scroll re-renders once per step (px). */
const BAND_STEP = 400

/**
 * The band worth drawing around a view, quantized to {@link BAND_STEP}.
 * @param top - the view's top, in the coordinates the band is measured in.
 * @param height - the view's height.
 * @returns the band's top and bottom, margins included.
 */
export function bandAround(top: number, height: number): { readonly from: number; readonly to: number } {
  return {
    from: Math.floor((top - BAND_MARGIN) / BAND_STEP) * BAND_STEP,
    to: Math.ceil((top + height + BAND_MARGIN) / BAND_STEP) * BAND_STEP,
  }
}

/**
 * Measure the band on every scroll and resize of the scrolling box, at most
 * once per frame.
 * @param box - the scrolling box.
 * @param measure - the measurement; always the latest one passed.
 * @param again - measured afresh (and subscribed again) when this changes:
 *   what the band is measured over, when its layout moves.
 * @param first - `now` measures at once on subscribing, `frame` on the next frame.
 */
export function useScrollMeasure(
  box: RefObject<HTMLElement | null>,
  measure: () => void,
  again: unknown,
  first: 'now' | 'frame',
): void {
  const latest = useRef(measure)
  latest.current = measure
  useEffect(() => {
    const node = box.current
    if (node === null) return
    let frame = 0
    const run = (): void => {
      frame = 0
      latest.current()
    }
    const onScroll = (): void => { if (frame === 0) frame = requestAnimationFrame(run) }
    if (first === 'now') run()
    else onScroll()
    node.addEventListener('scroll', onScroll, { passive: true })
    const watch = new ResizeObserver(onScroll)
    watch.observe(node)
    return () => {
      node.removeEventListener('scroll', onScroll)
      watch.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [box, again, first])
}

/**
 * Add a page as the end of the wall comes near the screen.
 * @param tail - the marker after the last drawn card.
 * @param shown - how many are drawn.
 * @param total - how many there are.
 * @param grow - draw one page more.
 * @param rootMargin - how far ahead of the screen the end counts as near.
 */
export function useGrowOnTail(
  tail: RefObject<Element | null>,
  shown: number,
  total: number,
  grow: () => void,
  rootMargin: string,
): void {
  const latest = useRef(grow)
  latest.current = grow
  useEffect(() => {
    const node = tail.current
    if (node === null || shown >= total) return
    const watch = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) latest.current()
    }, { rootMargin })
    watch.observe(node)
    return () => { watch.disconnect() }
  }, [tail, shown, total, rootMargin])
}
