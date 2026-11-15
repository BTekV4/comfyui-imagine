/**
 * The frame every dialog over the canvas uses, its footer and the request
 * they share. It lived in ClipDialogs.tsx while four dialogs imported it from
 * there; each of them also rewrote the same busy/error/POST and the same
 * footer (2026-10-25).
 * @module Modal
 */

import { messageOf } from './message-of.ts'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { postJson } from './http.ts'
import { translate } from './locale-store.ts'
import css from './Modal.module.css'

/**
 * A dialog over the studio: a title, a close button, and Escape or a press
 * on the backdrop to leave it.
 *
 * Escape is taken once, on the window before anything else: the dialog used
 * to listen twice (on the window and on itself), and with the focus outside
 * it the page's own Escape cleared the canvas's selection under it as well.
 * @param props.className - an extra class for the dialog box (a narrower one).
 */
export function Modal({ title, onClose, className, children }: { title: string; onClose: () => void; className?: string; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null)
  // Callers pass a fresh closure every render: the listener reads the latest
  // one instead of being torn down and added again each time.
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    // Focus inside the dialog, so the keyboard is in it and not on the canvas.
    const node = dialog.current
    if (node !== null && !node.contains(document.activeElement)) node.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, [])
  return (
    <div className={css.backdrop} role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div
        ref={dialog}
        className={className === undefined ? css.dialog : `${css.dialog} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className={css.head}>
          <span className={css.title}>{title}</span>
          <button type="button" className={css.close} aria-label={translate('imagine.closeShort')} onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** The footer's two button styles, for the buttons a dialog puts in it. */
export const dialogButton = { primary: css.primary, secondary: css.secondary } as const

/**
 * A dialog's last row: what is going on (or what went wrong) and its buttons.
 * @param props.hint - the line on the left, which takes the free width.
 * @param props.lead - a button that goes before the line rather than after.
 * @param props.spaced - keep some air from a picture above.
 */
export function DialogFooter({ hint, lead, spaced, children }: {
  hint: ReactNode
  lead?: ReactNode
  spaced?: boolean
  children: ReactNode
}) {
  return (
    <div className={spaced === true ? `${css.actions} ${css.spaced}` : css.actions}>
      {lead}
      <span className={css.hint} role="status">{hint}</span>
      {children}
    </div>
  )
}

/**
 * One request a dialog makes to the host (a trim, a crop, an erase), with its
 * busy flag and its error line.
 * @param url - the host route.
 * @param label - what failed, for the fallback message.
 * @returns the state and `run`, which posts the body and hands the answer on.
 */
export function useHostEdit<T>(url: string, label: string): {
  readonly busy: boolean
  readonly error: string | undefined
  readonly clearError: () => void
  readonly run: (body: unknown, onDone: (answer: T) => void) => Promise<void>
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const run = async (body: unknown, onDone: (answer: T) => void): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      onDone(await postJson<T>(url, body, label))
    } catch (caught: unknown) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, clearError: () => { setError(undefined) }, run }
}
