/**
 * How every popup of the studio closes: a press outside it, or Escape.
 * Menus and cards each wrote the same two window listeners by hand, and the
 * ones that forgot stayed open until clicked again.
 */
import { useEffect, useRef, type RefObject } from 'react'

/**
 * Close a popup on a press outside `box` or on Escape, while `open`.
 * @param box - the popup's element; presses inside it are its own.
 * @param onClose - what closing does; the latest one is always called.
 * @param open - false leaves the listeners off (a closed menu).
 */
export function useDismiss(box: RefObject<HTMLElement | null>, onClose: () => void, open = true): void {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) close.current()
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close.current() }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [box, open])
}
