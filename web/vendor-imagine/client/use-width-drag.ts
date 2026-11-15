/**
 * The chat column's width, dragged from its edge handle.
 *
 * The width follows the pointer on screen only, written straight into the
 * page (a CSS variable): a React state per pointermove drew the whole studio
 * again on every step. The store gets it once, on release, since the store is
 * persisted whole to localStorage.
 * @module use-width-drag
 */

import { useEffect, useRef } from 'react'

/** The part of a pointerdown a width drag reads. */
export type WidthDragStart = { clientX: number; preventDefault(): void }

/**
 * Follow the pointer from a column's edge handle until it is released.
 * @param event - the pointerdown on the handle.
 * @param start - the column's rendered width when the drag began.
 * @param apply - receives the dragged width on every move, for the screen only.
 * @param commit - receives the final width once, on release, to be stored.
 * @returns what takes the listeners off without committing, for an unmount.
 */
function dragWidth(
  event: WidthDragStart,
  start: number,
  apply: (width: number) => void,
  commit: (width: number) => void,
): () => void {
  event.preventDefault()
  const origin = event.clientX
  let last = start
  const move = (next: PointerEvent): void => {
    last = start + (next.clientX - origin)
    apply(last)
  }
  const detach = (): void => {
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    document.removeEventListener('pointercancel', stop)
  }
  // A cancelled pointer (a touch taken over by the system) ends the drag too,
  // or the listeners stayed attached and the width never reached the store.
  const stop = (): void => {
    detach()
    commit(last)
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', stop)
  document.addEventListener('pointercancel', stop)
  return detach
}

/**
 * @param apply - shows a width while the drag is on, without a render.
 * @param commit - stores the final width.
 * @returns the handler that starts a drag from the width the column is drawn
 * at. `limit` clamps every width the drag produces, on screen and in the
 * store alike.
 */
export function useWidthDrag(apply: (width: number) => void, commit: (width: number) => void): {
  readonly start: (event: WidthDragStart, from: number, limit?: (width: number) => number) => void
} {
  /** The drag in progress, so an unmount mid-drag takes its listeners off. */
  const detachRef = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => { detachRef.current?.() }, [])
  const start = (event: WidthDragStart, from: number, limit: (width: number) => number = width => width): void => {
    detachRef.current?.()
    detachRef.current = dragWidth(
      event,
      from,
      (width) => { apply(limit(width)) },
      (width) => { detachRef.current = undefined; commit(limit(width)) },
    )
  }
  return { start }
}
