/**
 * Moving and resizing tiles on the board: a press that becomes a drag past a
 * threshold, a corner resize about the opposite corner, the snapping to the
 * other tiles' edges with its orange guides, and the board saved once on
 * release. Split out of Board.tsx (2026-11-07).
 * @module use-tile-drag
 */

import { useMemo, useState, type MutableRefObject } from 'react'
import type { CanvasRect } from '../../../shared/imagine-projects.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { DRAG_THRESHOLD, MAX_TILE_SCALE, MIN_TILE_SCALE, moveTile } from './canvas-layout.ts'
import type { ImagineCanvasTool } from './gallery-store.ts'
import type { TileCorner } from './Tile.tsx'

/**
 * The nearest of some lines to some values, within a tolerance.
 * @param lines - the other tiles' edges.
 * @param values - the moved tile's edges.
 * @param tolerance - how far a snap reaches, in world units.
 * @returns the line and the shift that reaches it, or undefined.
 */
function nearest(lines: readonly number[], values: readonly number[], tolerance: number): { line: number; delta: number } | undefined {
  let best: { line: number; delta: number } | undefined
  for (const value of values) {
    for (const line of lines) {
      const delta = line - value
      if (Math.abs(delta) <= tolerance && (best === undefined || Math.abs(delta) < Math.abs(best.delta))) best = { line, delta }
    }
  }
  return best
}

/** A tile's press, as the board hands it to the page. */
export type PressEvent = {
  clientX: number
  clientY: number
  button?: number
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  preventDefault(): void
}

/** What the tile drag reads of the board, current on every render. */
export interface TileDragContext {
  readonly rects: readonly CanvasRect[]
  readonly itemsByName: ReadonlyMap<string, GalleryItem>
  readonly picked: readonly string[]
  readonly zoom: number
  /** Space held down: the board pans and the tile leaves the press to it. */
  readonly spaceRef: MutableRefObject<boolean>
  readonly pointOf: (event: { clientX: number; clientY: number }) => { x: number; y: number } | undefined
  /** The tool one press acts with. */
  readonly pressTool: (event: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number }) => ImagineCanvasTool
  readonly onPress: (id: string, picked: readonly string[], additive: boolean) => void
  readonly onSelectOne: (id: string) => void
  readonly onPlace: (rects: readonly CanvasRect[]) => void
}

export function useTileDrag(ctx: TileDragContext) {
  const { rects, itemsByName, picked, zoom, spaceRef, pointOf } = ctx
  // Named as in Board, where this code lived.
  const props = ctx
  const [drag, setDrag] = useState<{
    id: string
    ids: readonly string[]
    additive: boolean
    originX: number
    originY: number
    starts: Readonly<Record<string, { x: number; y: number }>>
    x: number
    y: number
    active: boolean
  } | undefined>(undefined)
  /**
   * A tile being resized from a corner, as Grok Imagine's canvas does: one
   * factor for both sides, the opposite corner held still, the factor
   * following the pointer's distance from that corner.
   */
  const [resize, setResize] = useState<{
    id: string
    corner: TileCorner
    anchorX: number
    anchorY: number
    baseW: number
    baseH: number
    startScale: number
    startDist: number
    scale: number
  } | undefined>(undefined)
  /** Orange alignment lines while a tile is moved or resized, in world units. */
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({})

  const liveRects = useMemo(() => {
    if (resize !== undefined) {
      const w = Math.round(resize.baseW * resize.scale)
      const h = Math.round(resize.baseH * resize.scale)
      const west = resize.corner === 'nw' || resize.corner === 'sw'
      const north = resize.corner === 'nw' || resize.corner === 'ne'
      return rects.map(rect => (rect.id === resize.id
        ? { ...rect, x: west ? resize.anchorX - w : resize.anchorX, y: north ? resize.anchorY - h : resize.anchorY, w, h, scale: resize.scale }
        : rect))
    }
    if (drag === undefined || !drag.active) return rects
    let next = rects
    const dx = drag.x - (drag.starts[drag.id]?.x ?? drag.x)
    const dy = drag.y - (drag.starts[drag.id]?.y ?? drag.y)
    for (const id of drag.ids) {
      const start = drag.starts[id]
      if (start === undefined) continue
      next = moveTile(next, id, start.x + dx, start.y + dy)
    }
    return next
  }, [rects, drag, resize])

  const startResize = (id: string, corner: TileCorner, event: { clientX: number; clientY: number; button: number; stopPropagation(): void; preventDefault(): void }): void => {
    event.stopPropagation()
    if (event.button !== 0) return
    event.preventDefault()
    const rect = rects.find(entry => entry.id === id)
    const point = pointOf(event)
    if (rect === undefined || point === undefined) return
    const scale = rect.scale ?? 1
    const anchorX = corner === 'nw' || corner === 'sw' ? rect.x + rect.w : rect.x
    const anchorY = corner === 'nw' || corner === 'ne' ? rect.y + rect.h : rect.y
    setResize({
      id,
      corner,
      anchorX,
      anchorY,
      baseW: rect.w / scale,
      baseH: rect.h / scale,
      startScale: scale,
      // Never under 20 screen pixels, so a press right on the corner does not
      // make the factor leap.
      startDist: Math.max(Math.hypot(point.x - anchorX, point.y - anchorY), 20 / zoom),
      scale,
    })
  }

  /**
   * The edges of every other tile: what a moved or resized tile snaps to.
   * @param exclude - the tiles being moved.
   */
  const snapLines = (exclude: readonly string[]): { xs: number[]; ys: number[] } => {
    const xs: number[] = []
    const ys: number[] = []
    for (const other of rects) {
      if (exclude.includes(other.id)) continue
      xs.push(other.x, other.x + other.w)
      ys.push(other.y, other.y + other.h)
    }
    return { xs, ys }
  }

  const pressTile = (id: string, event: PressEvent): void => {
    const point = pointOf(event)
    const rect = rects.find(entry => entry.id === id)
    if (point === undefined || rect === undefined) return
    // The board pans on these; the tile leaves the press to it.
    if (event.button === 1 || spaceRef.current) return
    event.preventDefault()
    // Shift and cmd add to the selection (Grok's multiSelectionKeyCode). The
    // tool does not matter: under the hand a tile is still picked and dragged.
    const additive = event.shiftKey === true || event.metaKey === true
    const nextPicked = additive
      ? (picked.includes(id) ? picked.filter(entry => entry !== id) : [...picked, id])
      : (picked.includes(id) ? picked : [id])
    props.onPress(id, nextPicked, additive)
    const group = nextPicked.includes(id) ? nextPicked : [id]
    const starts: Record<string, { x: number; y: number }> = {}
    for (const entry of group) {
      const current = rects.find(tile => tile.id === entry)
      if (current !== undefined) starts[entry] = { x: current.x, y: current.y }
    }
    setDrag({
      id,
      ids: group,
      additive,
      originX: point.x,
      originY: point.y,
      starts,
      x: rect.x,
      y: rect.y,
      active: false,
    })
  }

  /** Follow a resize in progress; true when there was one. */
  const moveResize = (point: { x: number; y: number }): boolean => {
    if (resize !== undefined) {
      let scale = Math.min(MAX_TILE_SCALE, Math.max(MIN_TILE_SCALE,
        Math.hypot(point.x - resize.anchorX, point.y - resize.anchorY) / resize.startDist * resize.startScale))
      // The free corner's edges snap to the other tiles' edges.
      const west = resize.corner === 'nw' || resize.corner === 'sw'
      const north = resize.corner === 'nw' || resize.corner === 'ne'
      const edgeX = resize.anchorX + (west ? -1 : 1) * resize.baseW * scale
      const edgeY = resize.anchorY + (north ? -1 : 1) * resize.baseH * scale
      const { xs, ys } = snapLines([resize.id])
      const tolerance = 6 / zoom
      const sx = nearest(xs, [edgeX], tolerance)
      const sy = nearest(ys, [edgeY], tolerance)
      const options = [
        ...sx === undefined ? [] : [{ scale: Math.abs(sx.line - resize.anchorX) / resize.baseW, guide: { x: sx.line } }],
        ...sy === undefined ? [] : [{ scale: Math.abs(sy.line - resize.anchorY) / resize.baseH, guide: { y: sy.line } }],
      ].filter(option => option.scale >= MIN_TILE_SCALE && option.scale <= MAX_TILE_SCALE)
        .sort((a, b) => Math.abs(a.scale - scale) - Math.abs(b.scale - scale))
      const snap = options[0]
      if (snap !== undefined) scale = snap.scale
      setGuides(snap?.guide ?? {})
      setResize({ ...resize, scale })
      return true
    }
    return false
  }
  /** Follow a press or a drag in progress. */
  const moveDrag = (point: { x: number; y: number }): void => {
    if (drag === undefined) return
    const dx = point.x - drag.originX
    const dy = point.y - drag.originY
    // The threshold is a distance the HAND travels, so it belongs in screen
    // pixels. dx/dy come out of pointOf already divided by the zoom, so
    // comparing them raw made the threshold shrink with the zoom: at 0.4x a
    // 2.4-pixel tremor during a click counted as a drag, moved the tile and
    // pinned it into `placed` for good. Multiply back.
    const active = drag.active || Math.hypot(dx, dy) * zoom >= DRAG_THRESHOLD
    const start = drag.starts[drag.id]
    let x = (start?.x ?? drag.x) + dx
    let y = (start?.y ?? drag.y) + dy
    // The pressed tile's edges and centre line up with the others' edges, as
    // Grok's helper lines do; the rest of a multi-selection moves with it.
    const own = rects.find(rect => rect.id === drag.id)
    if (active && own !== undefined) {
      const { xs, ys } = snapLines(drag.ids)
      const tolerance = 6 / zoom
      const sx = nearest(xs, [x, x + own.w / 2, x + own.w], tolerance)
      const sy = nearest(ys, [y, y + own.h / 2, y + own.h], tolerance)
      if (sx !== undefined) x += sx.delta
      if (sy !== undefined) y += sy.delta
      setGuides({ ...sx === undefined ? {} : { x: sx.line }, ...sy === undefined ? {} : { y: sy.line } })
    }
    setDrag({ ...drag, active, x, y })
  }
  /** End a resize in progress, saving the board; true when there was one. */
  const endResize = (): boolean => {
    if (resize !== undefined) {
      props.onPlace(liveRects.filter(rect => itemsByName.has(rect.id) || rect.id === resize.id))
      setResize(undefined)
      return true
    }
    return false
  }
  /** End a press or a drag in progress. */
  const endDrag = (): void => {
    if (drag === undefined) return
    if (drag.active) {
      // Save the whole board, not just what was dragged. A tile with no saved
      // rect is packed against the column bottoms the saved ones reserve, so
      // persisting only the moved tile left every untouched tile free to be
      // repacked somewhere else — dragging one thing rearranged the rest.
      // Job tiles are skipped: their id dies when the job produces its file.
      props.onPlace(liveRects.filter(rect => itemsByName.has(rect.id) || drag.ids.includes(rect.id)))
    } else if (!drag.additive && drag.ids.length > 1) {
      // A plain click on a tile of a multi-selection collapses onto it, so the
      // per-tile tools (which need exactly one pick) stay reachable.
      props.onSelectOne(drag.id)
    }
    setDrag(undefined)
  }
  const clearGuides = (): void => { setGuides({}) }

  return { drag, guides, liveRects, startResize, pressTile, moveResize, moveDrag, endResize, endDrag, clearGuides }
}
