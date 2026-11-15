/** Shared props for every product icon component. */
export interface IconProps {
  /** Square edge in px; defaults to the glyph's own drawn size. */
  size?: number | undefined
  /** Extra class for layout placement; color rides currentColor.
   * (`| undefined` for exactOptionalPropertyTypes: callers forward their own optional prop.) */
  className?: string | undefined
  /** Line weight in the glyph's grid (one unit unless said): a glyph drawn
   * larger than its grid passes a lighter one to keep the same line. */
  strokeWidth?: number | undefined
}
