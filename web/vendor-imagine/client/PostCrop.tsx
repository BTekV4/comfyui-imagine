/**
 * «Ritaglia» on the photo itself, as Grok's post page (2026-11-15): the whole
 * photo framed to start with, the rest of the page dimmed, a rule-of-thirds
 * grid, corner and edge handles, the frame dragged from inside, and «Annulla»
 * / «✓ Ritaglia» under the photo. The crop is a new file beside the original
 * (`/api/crop-copy`), as the old dialog made it.
 * @module PostCrop
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ImagineRegion } from '../../../shared/imagine-types.ts'
import { translate } from './locale-store.ts'
import type { Box } from './SegmentsPanel.tsx'
import css from './PostCrop.module.css'

/** Smallest side of the frame, as a share of the photo. */
const MIN_SIDE = 0.05

type Grip = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

export function PostCrop({ drawn, frame, busy, error, onCancel, onCrop }: {
  /** The picture, in viewport pixels. */
  drawn: Box
  /** The element the frame is positioned in (the viewer's stage frame). */
  frame: HTMLDivElement | null
  busy: boolean
  error: string | undefined
  onCancel: () => void
  onCrop: (region: ImagineRegion) => void
}) {
  const [region, setRegion] = useState<ImagineRegion>({ x: 0, y: 0, w: 1, h: 1 })
  const grab = useRef<{ grip: Grip; x: number; y: number; from: ImagineRegion } | undefined>(undefined)
  const origin = frame?.getBoundingClientRect()
  if (origin === undefined) return null

  const start = (grip: Grip) => (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || busy) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    grab.current = { grip, x: event.clientX, y: event.clientY, from: region }
  }
  const move = (event: ReactPointerEvent<HTMLElement>): void => {
    const g = grab.current
    if (g === undefined) return
    const dx = (event.clientX - g.x) / drawn.width
    const dy = (event.clientY - g.y) / drawn.height
    const f = g.from
    if (g.grip === 'move') {
      setRegion({ ...f, x: Math.min(1 - f.w, Math.max(0, f.x + dx)), y: Math.min(1 - f.h, Math.max(0, f.y + dy)) })
      return
    }
    let left = f.x
    let top = f.y
    let right = f.x + f.w
    let bottom = f.y + f.h
    if (g.grip.includes('w')) left = Math.min(right - MIN_SIDE, Math.max(0, f.x + dx))
    if (g.grip.includes('e')) right = Math.max(left + MIN_SIDE, Math.min(1, f.x + f.w + dx))
    if (g.grip.includes('n')) top = Math.min(bottom - MIN_SIDE, Math.max(0, f.y + dy))
    if (g.grip.includes('s')) bottom = Math.max(top + MIN_SIDE, Math.min(1, f.y + f.h + dy))
    setRegion({ x: left, y: top, w: right - left, h: bottom - top })
  }
  const end = (): void => { grab.current = undefined }

  const box = {
    left: drawn.left - origin.left + region.x * drawn.width,
    top: drawn.top - origin.top + region.y * drawn.height,
    width: region.w * drawn.width,
    height: region.h * drawn.height,
  }
  const whole = region.x === 0 && region.y === 0 && region.w === 1 && region.h === 1
  return (
    <>
      <div className={css.shade} aria-hidden="true" />
      <div className={css.frame} style={box} onPointerDown={start('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <span className={css.thirdV} style={{ left: '33.333%' }} />
        <span className={css.thirdV} style={{ left: '66.666%' }} />
        <span className={css.thirdH} style={{ top: '33.333%' }} />
        <span className={css.thirdH} style={{ top: '66.666%' }} />
        {(['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'] as const).map(grip => (
          <span key={grip} className={css.grip} data-g={grip} onPointerDown={start(grip)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
        ))}
      </div>
      {createPortal(
        <div className={css.bar} style={{ left: drawn.left + drawn.width / 2, top: Math.min(window.innerHeight - 52, drawn.top + drawn.height + 12) }}>
          {error !== undefined && <span className={css.error}>{error}</span>}
          <button type="button" className={css.cancel} disabled={busy} onClick={onCancel}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
            {translate('imagine.cancel')}
          </button>
          <button type="button" className={css.apply} disabled={busy || whole} onClick={() => { onCrop(region) }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {translate('imagine.crop')}
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}
