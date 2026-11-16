/**
 * The studio's own glyphs, the ones the shared icon set lacks: the tile and
 * viewer actions, the canvas toolbar, the post panel's tools. They used to be
 * drawn in three files with three local wrappers (here, CanvasToolbar.tsx and
 * PostPanel.tsx), and some glyphs twice; one wrapper and one glyph per action
 * now, with each place passing its own size and weight.
 */
import type { ReactNode } from 'react'

/** A glyph's size in px and its line weight in the 24-unit grid. */
export type GlyphProps = { size?: number; strokeWidth?: number }
type P = GlyphProps

/**
 * The outline wrapper every glyph here is drawn in: a 24-unit grid, round
 * caps and joins.
 */
export const Glyph = ({ size = 16, strokeWidth = 1.8, children }: P & { children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const S = Glyph
export const IconDetails = (p: P) => <S {...p}><path d="M4 6h8M4 10h16M4 14h12M4 18h8" /></S>
export const IconVideo = (p: P) => <S {...p}><rect x="3" y="6" width="13" height="12" rx="2.5" /><path d="m16 10 5-3v10l-5-3" /></S>
export const IconCut = (p: P) => <S {...p}><circle cx="6" cy="7" r="2.5" /><circle cx="6" cy="17" r="2.5" /><path d="M8.2 8.3 20 18M8.2 15.7 20 6" /></S>
export const IconFrame = (p: P) => <S {...p}><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4" /></S>
export const IconMerge = (p: P) => <S {...p}><rect x="3" y="7" width="7" height="10" rx="1.5" /><rect x="14" y="7" width="7" height="10" rx="1.5" /><path d="M10 12h4" /></S>
export const IconUpscale = (p: P) => <S {...p}><path d="M4 20h16M12 16V4M7 9l5-5 5 5" /></S>
export const IconExtend = (p: P) => <S {...p}><rect x="3" y="6" width="10" height="12" rx="2" /><path d="M16 12h5M18.5 9.5 21 12l-2.5 2.5" /></S>
/** Person cut out of a dashed frame: background removal. */
export const IconCutout = (p: P) => <S {...p}><rect x="3" y="3" width="18" height="18" rx="3" strokeDasharray="3 3" /><circle cx="12" cy="10" r="3" /><path d="M6.5 19c1-3 3.2-4.5 5.5-4.5s4.5 1.5 5.5 4.5" /></S>
/** A dashed zone with a pencil: "Precise edit". */
export const IconRegion = (p: P) => <S {...p}><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M4 15v4a1 1 0 0 0 1 1h4" /><path d="m13 20 1-3 5.5-5.5a1.4 1.4 0 0 1 2 2L16 19l-3 1Z" /></S>
/** Two boxes and a small one: «Segments», as Grok draws it. */
export const IconSegments = (p: P) => <S {...p}><rect x="2" y="9" width="8" height="7" rx="1.5" /><rect x="12" y="3" width="9" height="8" rx="2" /><rect x="13" y="15" width="6" height="6" rx="1.5" /></S>
/** Stacked cards: the Library. */
export const IconLibrary = (p: P) => <S {...p}><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M6 5h12M8 2.5h8" /></S>

/** An eraser: "Remove object". */
export function EraseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m6.2 13.5-3.4-3.4a1.2 1.2 0 0 1 0-1.7l6-6a1.2 1.2 0 0 1 1.7 0l3.4 3.4a1.2 1.2 0 0 1 0 1.7l-6 6M6.2 13.5h7.3M5 7l4.4 4.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Crop marks: the crop action of the tiles and menus, and the viewer's crop
 * tool (PostPanel draws it at 20 px). The 2.1 weight keeps the 1.4 px line
 * the 16-unit glyph had at 16 px.
 */
export const CropIcon = ({ size = 16, strokeWidth = 2.1 }: P) => <S size={size} strokeWidth={strokeWidth}><path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22V8a2 2 0 0 0-2-2H2" /></S>

/* ── The canvas toolbar (Grok's glyphs) ───────────────────────────────────── */

/** The four-way move mark: the hand tool. */
export const IconHand = (p: P) => <S {...p}><path d="M12 3v18M3 12h18M12 3 9.5 5.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" /></S>
/** A photo: generate an image. */
export const IconImage = (p: P) => <S {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4.5 4 3.5 2.5-2 4.5 3.5" /></S>
/** A bare T: a text note. */
export const IconText = (p: P) => <S {...p}><path d="M5 5h14M12 5v15" /></S>
/** An arrow out of a tray: upload. */
export const IconUpload = (p: P) => <S {...p}><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" /><path d="M4 14v3.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V14" /></S>
/** Four squares: arrange the board. */
export const IconGrid = (p: P) => <S {...p}><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></S>

/* ── The viewer's post panel and its tools ────────────────────────────────── */

/** Grok's «Precise edit»: a brush over a dotted zone. */
export const IconPrecise = (p: P) => <S {...p}><path d="M4 20c1.5 0 3-1 3-3a2 2 0 1 0-4 0" /><path d="m7 15 9.5-9.5a2.1 2.1 0 0 1 3 3L10 18" /><path d="M14 4.5 15.5 3M19.5 9 21 7.5" /></S>
/** A pencil: «Draw», the tool and its own buttons. */
export const IconPencil = (p: P) => <S {...p}><path d="m15 5 4 4" /><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z" /></S>
/** An arrow up: send what is written (the viewer's bars). */
export const IconArrowUp = ({ size = 16, strokeWidth = 2 }: P) => <S size={size} strokeWidth={strokeWidth}><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" /></S>

/**
 * A frame with a side column: show, hide or fold a side panel (the studio's
 * canvas buttons, the viewer's panel toggle).
 * @param props.dots - the column holds content: two short lines in it.
 */
export const IconSidePanel = ({ size = 16, strokeWidth = 2.1, dots = false }: P & { dots?: boolean }) => (
  <S size={size} strokeWidth={strokeWidth}>
    <rect x="3" y="3.75" width="18" height="16.5" rx="3.75" />
    <path d="M15 3.75v16.5" />
    {dots && <path d="M17.25 9.75h1.5M17.25 13.5h1.5" />}
  </S>
)

/**
 * The "Like" heart, for the viewer's column and All media.
 * @param props.color - the colour it is filled with; outline only when absent.
 */
export function IconHeart({ color }: { color?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={color ?? 'none'} stroke={color ?? 'currentColor'} strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20Z" />
    </svg>
  )
}
