/**
 * The glyphs of the two apps the rail opens inside the studio (2026-11-09):
 * Openjutsu (video swaps on ComfyUI) and IOPaint (erase an object). Stroked
 * outlines in `currentColor`, like the rail's other entries.
 * @module app-marks
 */

/**
 * Openjutsu: a four-pointed throwing star around a hole.
 * @param props.size - the square's side, in pixels.
 * @returns the mark.
 */
export function OpenjutsuMark({ size = 16 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d="M8 1.5 9.6 6.4 14.5 8 9.6 9.6 8 14.5 6.4 9.6 1.5 8 6.4 6.4Z" />
      <circle cx="8" cy="8" r="1.3" />
    </svg>
  )
}

/**
 * IOPaint: an eraser on a stroke it leaves clean.
 * @param props.size - the square's side, in pixels.
 * @returns the mark.
 */
export function IOPaintMark({ size = 16 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d="M9.2 2.6 13.4 6.8 7.6 12.6H4.9L2.6 10.3a1.2 1.2 0 0 1 0-1.7Z" />
      <path d="M5.9 5.9 10.1 10.1" />
      <path d="M7.6 12.6h5.9" />
    </svg>
  )
}
