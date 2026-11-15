/**
 * The puzzle piece of the Plugins page: one glyph, drawn at 16px, beside the
 * other rail entries and in the page's header.
 *
 * A silhouette with a knob on top and a socket on the right, which is the shape
 * the word "plugin" means here; stroked, not filled, so it matches the rest of
 * the rail's outlines.
 * @param props.size - the square's side, in pixels.
 * @returns the mark.
 */
export function PluginMark({ size = 16 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 5.4h3.1a1.9 1.9 0 0 1 3.8 0H13v3.1a1.9 1.9 0 0 0 0 3.8V15.4H9.9a1.9 1.9 0 0 1-3.8 0H3V5.4Z" />
    </svg>
  )
}
