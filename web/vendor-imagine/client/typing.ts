/**
 * Whether a key press belongs to a field the user is typing in, so the page's
 * own shortcuts (Space to pan, Canc to delete, Ctrl+S…) leave it alone.
 *
 * One check for the board and the page: until 2026-10-25 they had one each and
 * only the board's counted a `<select>`, so Canc on a focused menu could open
 * the delete confirmation for the selected tiles.
 * @module typing
 */

/**
 * @param target - the event's target.
 * @returns true for inputs, text areas, selects and editable content.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
}
