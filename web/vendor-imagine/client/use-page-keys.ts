/**
 * The studio's keyboard: Tab kept inside the page, Ctrl+S/P for the canvas
 * tools, Grok's Ctrl+I/U/E on a project, Canc on the selection, and Escape
 * closing the innermost thing open. Split out of ImaginePage.tsx (2026-10-25).
 * @module use-page-keys
 */

import { useEffect, useRef, type RefObject } from 'react'
import type { BoardHandle, CanvasSession } from './Board.tsx'
import type { ImagineView } from './gallery-store.ts'
import type { ImaginePageProps } from './props.ts'
import { isTypingTarget } from './typing.ts'

/** What the focus trap treats as a stop; `tabIndex >= 0` filters the rest. */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]'

/** What the keys read and close, current on every render. */
export interface PageKeyState {
  readonly view: ImagineView
  readonly picked: readonly string[]
  /** A project's menu is open on the rail. */
  readonly menuOpen: boolean
  /** A project is being renamed on the rail. */
  readonly renaming: boolean
  /** The viewer is open. */
  readonly viewing: boolean
  readonly railDrawer: boolean
  /** Delete the named files, behind one confirmation. */
  readonly removeNamed: (names: readonly string[]) => void
  readonly closeMenu: () => void
  readonly stopRenaming: () => void
  readonly closeViewer: () => void
  readonly clearPicked: () => void
  readonly closeDrawer: () => void
}

/**
 * Listen to the keyboard for the life of the page. The listener is
 * registered once: it used to be torn down and added again — and the body's
 * overflow rewritten — on every change of the selection, and it read `items`
 * and `remove` from whichever render had registered it.
 * @param state - what the keys read, as of this render.
 * @param page - the page's root, the trap's inside.
 * @param board - the board, for its own shortcuts and Escape.
 * @param session - the board's view, for the text tool.
 * @param actions - the studio store's actions.
 */
export function usePageKeys(
  state: PageKeyState,
  page: RefObject<HTMLElement>,
  board: RefObject<BoardHandle>,
  session: CanvasSession,
  actions: ImaginePageProps['actions'],
): void {
  const latest = useRef(state)
  latest.current = state
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const current = latest.current
      /*
       * Keep Tab inside the dialog. The overlay declares aria-modal, but
       * nothing stopped the focus ring walking out of it: from the top of the
       * document the first nine stops were the chat underneath — its message
       * field included — and tabbing past the last control left again.
       */
      if (event.key === 'Tab') {
        const root = page.current
        if (root !== null) {
          const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
            .filter(node => node.checkVisibility() && node.tabIndex >= 0 && !node.hasAttribute('disabled'))
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (first !== undefined && last !== undefined) {
            const active = document.activeElement
            const inside = active instanceof HTMLElement && root.contains(active)
            if (!inside) {
              event.preventDefault();
              (event.shiftKey ? last : first).focus()
            } else if (event.shiftKey && active === first) {
              event.preventDefault()
              last.focus()
            } else if (!event.shiftKey && active === last) {
              event.preventDefault()
              first.focus()
            }
          }
        }
        return
      }
      const typing = isTypingTarget(event.target)
      if (!typing && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        if (event.key === 's' || event.key === 'S') {
          event.preventDefault()
          actions.setCanvasTool('select')
          return
        }
        if (event.key === 'p' || event.key === 'P') {
          event.preventDefault()
          actions.setCanvasTool('hand')
          return
        }
        // Grok's: Ctrl+I image, Ctrl+U video, Ctrl+E text.
        if (current.view === 'project') {
          const run = {
            i: () => { board.current?.openGenCard('image') },
            u: () => { board.current?.openGenCard('video') },
            e: () => { session.set({ textArmed: !session.get().textArmed }) },
          }[event.key.toLowerCase()]
          if (run !== undefined) {
            event.preventDefault()
            run()
            return
          }
        }
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!typing && board.current?.deleteSelectedNote() === true) {
          event.preventDefault()
          return
        }
        // The picked tiles are on the project board: elsewhere they are not on screen.
        if (current.view === 'project' && current.picked.length > 0 && !typing) {
          event.preventDefault()
          current.removeNamed(current.picked)
          return
        }
      }
      if (event.key !== 'Escape') return
      if (board.current?.escape() === true) return
      if (current.menuOpen) current.closeMenu()
      else if (current.renaming) current.stopRenaming()
      else if (current.viewing) current.closeViewer()
      else if (current.picked.length > 0) current.clearPicked()
      else if (current.railDrawer) current.closeDrawer()
    }
    document.addEventListener('keydown', onKeyDown)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previous
    }
  }, [actions, session, page, board])
}
