/**
 * A photo with a rectangle drawn on it: drag to draw, drag inside to move,
 * drag a corner to resize. Shared by "Precise edit" and "Crop"; the
 * crop locks the rectangle to a ratio, the edit leaves it free.
 */
import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { ImagineRegion } from '../../../shared/imagine-types.ts'
import css from './RegionEditDialog.module.css'

type Corner = 'nw' | 'ne' | 'sw' | 'se'
type Gesture =
  | { kind: 'draw'; x: number; y: number }
  | { kind: 'move'; x: number; y: number; from: ImagineRegion }
  | { kind: 'corner'; corner: Corner; from: ImagineRegion }

export const MIN_ZONE = 0.03
const clamp = (value: number, low = 0, high = 1): number => Math.min(Math.max(value, low), high)

/**
 * A rectangle from a fixed corner to the pointer, inside the picture. With a
 * ratio (width over height, in fractions of the photo) the height follows
 * the width, shrunk as a whole when it would leave the picture.
 */
function spanOf(ax: number, ay: number, bx: number, by: number, ratio: number | undefined): ImagineRegion {
  let w = Math.abs(clamp(bx) - ax)
  let h = Math.abs(clamp(by) - ay)
  const right = bx >= ax
  const down = by >= ay
  if (ratio !== undefined) {
    h = w / ratio
    const roomW = right ? 1 - ax : ax
    const roomH = down ? 1 - ay : ay
    const scale = Math.min(1, roomW / Math.max(w, 1e-6), roomH / Math.max(h, 1e-6))
    w *= scale
    h *= scale
  }
  return { x: right ? ax : ax - w, y: down ? ay : ay - h, w, h }
}

export interface ZoneFrameProps {
  readonly src: string
  readonly region: ImagineRegion | undefined
  readonly onRegion: (region: ImagineRegion | undefined) => void
  /** Width over height in fractions of the photo; undefined leaves it free. */
  readonly ratio?: number
  /** Painting instead of drawing a rectangle: the layer handles the pointer. */
  readonly children?: ReactNode
  readonly onPicture?: (image: HTMLImageElement) => void
  /** False while another layer (the brush) takes the pointer. */
  readonly interactive?: boolean
}

export function ZoneFrame({ src, region, onRegion, ratio, children, onPicture, interactive = true }: ZoneFrameProps) {
  const frame = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | undefined>(undefined)

  /** The pointer as fractions of the picture. */
  const at = (event: ReactPointerEvent): { x: number; y: number } => {
    const box = frame.current?.getBoundingClientRect()
    if (box === undefined || box.width === 0 || box.height === 0) return { x: 0, y: 0 }
    return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) }
  }

  const onDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!interactive || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = at(event)
    const corner = (event.target as HTMLElement).dataset.corner as Corner | undefined
    if (corner !== undefined && region !== undefined) {
      gesture.current = { kind: 'corner', corner, from: region }
    } else if (region !== undefined && point.x >= region.x && point.x <= region.x + region.w
      && point.y >= region.y && point.y <= region.y + region.h) {
      gesture.current = { kind: 'move', x: point.x, y: point.y, from: region }
    } else {
      gesture.current = { kind: 'draw', x: point.x, y: point.y }
      onRegion({ x: point.x, y: point.y, w: 0, h: 0 })
    }
  }

  const onMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = gesture.current
    if (current === undefined) return
    const point = at(event)
    if (current.kind === 'draw') {
      onRegion(spanOf(current.x, current.y, point.x, point.y, ratio))
    } else if (current.kind === 'move') {
      const { from } = current
      onRegion({
        ...from,
        x: clamp(from.x + point.x - current.x, 0, 1 - from.w),
        y: clamp(from.y + point.y - current.y, 0, 1 - from.h),
      })
    } else {
      const { from, corner } = current
      // The opposite corner stays where it is.
      const fixedX = corner === 'nw' || corner === 'sw' ? from.x + from.w : from.x
      const fixedY = corner === 'nw' || corner === 'ne' ? from.y + from.h : from.y
      onRegion(spanOf(fixedX, fixedY, point.x, point.y, ratio))
    }
  }

  const onUp = (): void => {
    if (gesture.current === undefined) return
    gesture.current = undefined
    // A click without a drag leaves no zone, not a dot.
    if (region !== undefined && (region.w < MIN_ZONE || region.h < MIN_ZONE)) onRegion(undefined)
  }

  const pct = (value: number): string => `${String(value * 100)}%`
  return (
    <div className={css.stage}>
      <div
        ref={frame}
        className={css.frame}
        data-interactive={interactive || undefined}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <img
          className={css.picture}
          src={src}
          alt=""
          draggable={false}
          onLoad={(event) => { onPicture?.(event.currentTarget) }}
        />
        {children}
        {interactive && region !== undefined && (
          // The photo outside the zone dimmed: what will stay as it is.
          <svg className={css.dim} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <path
              fillRule="evenodd"
              d={`M0 0H100V100H0Z M${String(region.x * 100)} ${String(region.y * 100)}h${String(region.w * 100)}v${String(region.h * 100)}h${String(-region.w * 100)}Z`}
            />
          </svg>
        )}
        {interactive && region !== undefined && (
          <div
            className={css.zone}
            style={{ left: pct(region.x), top: pct(region.y), width: pct(region.w), height: pct(region.h) }}
          >
            {(['nw', 'ne', 'sw', 'se'] as const).map(corner => (
              <span key={corner} className={css.corner} data-corner={corner} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
