/**
 * The marquee: a box dragged on the empty board that picks every tile it
 * touches, added to the selection with shift, cmd or ctrl. Split out of
 * Board.tsx (2026-11-07).
 * @module use-marquee
 */

import { useRef, useState } from 'react'
import type { CanvasRect } from '../../../shared/imagine-projects.ts'
import { boxFromPoints, idsInBox, type SelectBox } from './canvas-layout.ts'
import { sameList } from './imagine-projects.ts'

/** What the marquee reads of the board, current on every render. */
export interface MarqueeContext {
  readonly rects: readonly CanvasRect[]
  readonly picked: readonly string[]
  /** The selection set from the board. */
  readonly onPicked: (picked: readonly string[]) => void
  /** A marquee let go: what it picked is staged. */
  readonly onMarqueeEnd: (picked: readonly string[]) => void
  /** A plain press on the empty board: nothing picked, nothing staged. */
  readonly onClearPick: () => void
}

export function useMarquee(ctx: MarqueeContext) {
  const { rects, picked } = ctx
  // Named as in Board, where this code lived.
  const props = ctx
  const [marquee, setMarquee] = useState<{
    originX: number
    originY: number
    box: SelectBox
    base: readonly string[]
  } | undefined>(undefined)
  /** What the marquee has picked so far, handed to the page only when it changes. */
  const marqueePickedRef = useRef<readonly string[]>([])

  /**
   * Start a marquee at a point of the board.
   * @param point - where the press landed, in world units.
   * @param additive - whether it adds to the selection rather than replacing it.
   */
  const begin = (point: { x: number; y: number }, additive: boolean): void => {
    if (!additive) props.onClearPick()
    const base = additive ? picked : []
    marqueePickedRef.current = base
    setMarquee({
      originX: point.x,
      originY: point.y,
      box: { x: point.x, y: point.y, w: 0, h: 0 },
      base,
    })
  }
  /** Follow a marquee in progress; true when there was one. */
  const move = (point: { x: number; y: number }): boolean => {
    if (marquee !== undefined) {
      const box = boxFromPoints(marquee.originX, marquee.originY, point.x, point.y)
      setMarquee({ ...marquee, box })
      const hit = idsInBox(rects, box)
      const next = [...new Set([...marquee.base, ...hit])]
      // The page re-renders for a selection that changed, not for every move.
      if (!sameList(next, marqueePickedRef.current)) {
        marqueePickedRef.current = next
        props.onPicked(next)
      }
      return true
    }
    return false
  }
  /** Let a marquee go; true when there was one. */
  const end = (): boolean => {
    if (marquee !== undefined) {
      setMarquee(undefined)
      props.onMarqueeEnd(marqueePickedRef.current)
      return true
    }
    return false
  }

  return { box: marquee?.box, begin, move, end }
}
