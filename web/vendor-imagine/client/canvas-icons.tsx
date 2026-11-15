/**
 * The few canvas-toolbar glyphs the shared icon set lacks, drawn at the same
 * 16px grid and stroke as the rest (Grok-like icon-only selection bar).
 */
import type { ReactNode } from 'react'

type P = { size?: number }
const S = ({ size = 16, children }: P & { children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
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
/** Two boxes and a small one: «Segmenti», as Grok draws it. */
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

/** Crop marks: the viewer's crop action. */
export function CropIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 1.5v10h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M1.5 4.5h10v10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

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
