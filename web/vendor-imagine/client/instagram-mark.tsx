/**
 * The Instagram glyph: rounded square, lens and flash, drawn as strokes so it
 * takes the surrounding text colour. Used to mark the publication surfaces,
 * which post to that one service and no other.
 *
 * Outlines only, never the multicoloured wordmark tile: this labels a
 * destination inside Imagine and does not stand in for Instagram itself.
 */

/**
 * Render the Instagram glyph at the given size.
 * @param size - rendered side length in pixels.
 * @returns the glyph SVG, inheriting `currentColor`.
 */
export function InstagramMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" />
      <circle cx="12" cy="12" r="4.2" />
      <circle cx="17.4" cy="6.6" r="0.4" fill="currentColor" stroke="none" />
      <circle cx="17.4" cy="6.6" r="1.1" />
    </svg>
  )
}
