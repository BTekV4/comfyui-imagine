/**
 * Whether the last input came from a pointer, for the tooltips: focus that
 * arrives after a click (a closing menu refocusing its trigger) must not
 * raise a bubble, focus reached from the keyboard should.
 * Module-level listeners live for the document lifetime; Node imports are inert.
 */

let pointer = false

/**
 * Whether the last input came from a pointer.
 * @returns True after pointer input; false after any key.
 */
export function pointerModality(): boolean {
  return pointer
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => { pointer = true }, true)
  window.addEventListener('keydown', () => { pointer = false }, true)
}
