/**
 * Free-form Imagine canvas: pack new tiles into columns, keep user-moved
 * positions, and drop a tile onto a new column/row.
 * @module canvas-layout
 */

import type { CanvasRect } from '../../../shared/imagine-projects.ts'

/** The range a tile can be resized in, as a factor of the column width. */
export const MIN_TILE_SCALE = 0.75
export const MAX_TILE_SCALE = 3

/** The board's fixed tile width and row length: it does not follow the window. */
export const BOARD_COLUMN = 260
const BOARD_COLUMNS = 6
const GAP = 12
/** Frame used when the media's own pixel size is unknown (audio, bad header). */
const TILE_RATIO = 16 / 9
/**
 * Bounds on a tile's height/width. A panorama or a ribbon is still drawn at
 * its own shape, just not so extreme that it becomes a hairline or a tower
 * taller than the viewport.
 */
const MIN_RATIO = 1 / 3
const MAX_RATIO = 3

/**
 * A usable height/width for a tile.
 * @param ratio - the media's own height/width, when known.
 * @returns the clamped ratio, or the fallback frame when there is none.
 */
function clampRatio(ratio: number | undefined): number {
  if (ratio === undefined || !Number.isFinite(ratio) || ratio <= 0) return TILE_RATIO
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

/**
 * Height of one tile. The column width is uniform, so a tile's shape is its
 * media's: the board reads as a masonry of real aspect ratios instead of a
 * grid of portrait frames with letterboxed content inside them.
 * @param ratio - the media's height/width; omitted falls back to the frame.
 * @returns the tile height in canvas units.
 */
function tileHeight(ratio?: number): number {
  return Math.round(BOARD_COLUMN * clampRatio(ratio))
}

/**
 * Merge saved positions with the current id list. Missing ids get packed
 * in level rows, in the order given; leftover saved ids are dropped. The
 * board is a world of its own: six columns of BOARD_COLUMN, whatever the window.
 * @param ids - tiles that must appear.
 * @param saved - previously moved rects.
 * @param ratios - height/width per id; an id without one gets the fallback.
 * @param groupOf - the run each id belongs to: one row per run.
 * @returns one rect per id.
 */
export function layoutCanvas(
  ids: readonly string[],
  saved: Readonly<Record<string, CanvasRect>>,
  ratios: Readonly<Record<string, number>> = {},
  groupOf: Readonly<Record<string, string>> = {},
): readonly CanvasRect[] {
  const cols = BOARD_COLUMNS
  const column = BOARD_COLUMN
  const bottoms = Array.from({ length: cols }, () => 0)
  const used = new Set<string>()
  const placed: CanvasRect[] = []
  const heightOf = (id: string): number => tileHeight(ratios[id])

  for (const id of ids) {
    const previous = saved[id]
    /*
     * A saved rect that lies mostly on top of one already placed is a stale
     * one, not a choice: a file put back on a board after its upscale took its
     * place came back onto the same spot, under the upscale (2026-10-17). It
     * is packed like a new tile instead.
     */
    // A resized tile keeps its factor; its size still follows the column
    // width and the media's shape, so a new viewport scales it with the rest.
    const factor = Math.min(MAX_TILE_SCALE, Math.max(MIN_TILE_SCALE, previous?.scale ?? 1))
    const ownW = Math.round(column * factor)
    const ownH = Math.round(heightOf(id) * factor)
    // A resized tile is a deliberate size and place: never read as stale.
    const covered = previous !== undefined && previous.scale === undefined && placed.some((other) => {
      const w = Math.min(previous.x + ownW, other.x + other.w) - Math.max(previous.x, other.x)
      const hh = Math.min(previous.y + ownH, other.y + other.h) - Math.max(previous.y, other.y)
      return w > 0 && hh > 0 && w * hh > 0.5 * Math.min(ownW * ownH, other.w * other.h)
    })
    if (previous !== undefined && !covered) {
      const h = ownH
      // A saved rect keeps where the user put it and the factor it was
      // resized to; the base size follows the viewport and the media's shape.
      placed.push(previous.h === h && previous.w === ownW ? previous : { ...previous, w: ownW, h })
      used.add(id)
      // A moved tile is not snapped to the grid, so it can straddle two
      // columns: reserve every column it really overlaps, or the next packed
      // tile starts at y=0 in the neighbouring column and lands on top of it.
      // Test the overlap instead of dividing: the gap between two columns
      // belongs to neither of them.
      for (let col = 0; col < cols; col += 1) {
        const left = col * (column + GAP)
        if (previous.x < left + column && previous.x + ownW > left) {
          bottoms[col] = Math.max(bottoms[col] ?? 0, previous.y + h + GAP)
        }
      }
    }
  }

  /*
   * Unplaced tiles go in rows, left to right, in the order given, and every
   * row starts level. The shortest-column rule packed tighter, but the moment
   * two tiles differed in height (a song beside a clip) the next tile jumped
   * columns and the board stopped reading as a sequence: "Arrange in a grid"
   * is asked for to see the files in the order they were made, and reading
   * order is the point.
   */
  const pending = ids.filter(id => !used.has(id))
  // Below everything the user placed by hand: rows start level, so a short
  // tile does not pull the next row's tile up beside the row above.
  let rowTop = Math.max(0, ...bottoms)
  /*
   * One row per generation, as Grok Imagine lays its canvas out (2026-10-17):
   * a run's variants sit side by side and the next run starts a new row. A
   * group wider than the board wraps within itself.
   */
  const rows: string[][] = []
  let lastGroup: string | undefined
  for (const id of pending) {
    const group = groupOf[id] ?? `:${id}`
    const row = rows[rows.length - 1]
    if (row === undefined || row.length >= cols || group !== lastGroup) {
      rows.push([id])
    } else {
      row.push(id)
    }
    lastGroup = group
  }
  for (const row of rows) {
    let tallest = 0
    row.forEach((id, index) => {
      const h = heightOf(id)
      placed.push({ id, x: index * (column + GAP), y: rowTop, w: column, h })
      tallest = Math.max(tallest, h)
    })
    rowTop += tallest + GAP
  }
  return placed
}

/**
 * Move a tile to an unconstrained canvas point (no column snap).
 * @param current - the live rects.
 * @param id - the moved tile.
 * @param x - left edge on the canvas.
 * @param y - top edge on the canvas.
 * @returns the updated list.
 */
export function moveTile(
  current: readonly CanvasRect[],
  id: string,
  x: number,
  y: number,
): readonly CanvasRect[] {
  return current.map((rect) => {
    if (rect.id !== id) return rect
    return { ...rect, x, y }
  })
}

/** Distance that turns a press into a drag instead of a click. */
export const DRAG_THRESHOLD = 6

/** A line of wheel scroll, in pixels, when deltaMode says lines. */
const WHEEL_LINE = 16
/** A page of wheel scroll, in pixels, when deltaMode says pages. */
const WHEEL_PAGE = 400

/**
 * One wheel delta in pixels, whatever unit the browser reported it in.
 *
 * Trackpads report pixels, but a mouse wheel in Firefox reports lines and some
 * setups report pages: comparing those raw makes one notch move the canvas by
 * a few pixels instead of a few dozen.
 * @param value - deltaX or deltaY off the event.
 * @param mode - the event's deltaMode: 0 pixels, 1 lines, 2 pages.
 * @returns the delta in pixels.
 */
export function wheelPixels(value: number, mode: number): number {
  if (mode === 1) return value * WHEEL_LINE
  if (mode === 2) return value * WHEEL_PAGE
  return value
}

/** Chromium reports exactly this much `wheelDelta` per mouse notch. */
const CHROMIUM_NOTCH = 120

/**
 * Whether a wheel event comes from a mouse wheel rather than fingers on a
 * touchpad — the test Grok Imagine's canvas makes (useSmartWheel).
 *
 * A delta in lines or pages is a wheel: touchpads always report pixels, and
 * Firefox reports lines for a wheel. A `wheelDeltaY` that is a whole number of
 * Chromium notches is a wheel. Everything else is fingers. The size of the
 * delta says nothing: a high-resolution wheel reports the small fractional
 * values a touchpad reports, and reading those as fingers once left real mice
 * unable to zoom.
 * @param event - the wheel event's readable fields.
 * @returns true for a mouse wheel.
 */
export function isMouseWheel(event: { deltaMode: number; wheelDeltaY?: number }): boolean {
  if (event.deltaMode !== 0) return true
  const notch = event.wheelDeltaY
  return notch !== undefined && notch !== 0 && notch % CHROMIUM_NOTCH === 0
}

/** Trackpad / pinch zoom limits. 10% fits a whole large project on screen. */
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 4

/**
 * Keep canvas zoom inside the pinch range.
 * @param zoom - the raw scale.
 * @returns a clamped scale.
 */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/**
 * The camera that keeps one screen point still while the zoom changes: the
 * wheel at the pointer, a double click, the zoom buttons about the middle.
 * @param camera - the current translation.
 * @param from - the zoom the camera was computed for.
 * @param to - the new zoom.
 * @param px - the fixed point, in board pixels (x).
 * @param py - the fixed point, in board pixels (y).
 * @returns the translation for the new zoom.
 */
export function zoomAbout(
  camera: { readonly x: number; readonly y: number },
  from: number,
  to: number,
  px: number,
  py: number,
): { x: number; y: number } {
  return { x: px - (px - camera.x) / from * to, y: py - (py - camera.y) / from * to }
}

/**
 * The camera that puts a world point in the middle of what the user sees.
 * @param view - the visible part of the board: its left edge past the chat, its width and height.
 * @param centre - the world point to centre.
 * @param zoom - the zoom the camera is for.
 * @returns the translation.
 */
export function centreCamera(
  view: { readonly left: number; readonly width: number; readonly height: number },
  centre: { readonly x: number; readonly y: number },
  zoom: number,
): { x: number; y: number } {
  return { x: view.left + view.width / 2 - centre.x * zoom, y: view.height / 2 - centre.y * zoom }
}

/** Axis-aligned box used by marquee selection. */
export interface SelectBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Build a positive box from two canvas points.
 * @param ax - first x.
 * @param ay - first y.
 * @param bx - second x.
 * @param by - second y.
 * @returns the normalized box.
 */
export function boxFromPoints(ax: number, ay: number, bx: number, by: number): SelectBox {
  const x = Math.min(ax, bx)
  const y = Math.min(ay, by)
  return { x, y, w: Math.abs(bx - ax), h: Math.abs(by - ay) }
}

/**
 * Whether two axis-aligned boxes overlap.
 * @param a - first box.
 * @param b - second box.
 * @returns true when they intersect.
 */
function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/**
 * Ids whose tiles sit inside a marquee.
 * @param rects - placed tiles.
 * @param box - the selection rectangle.
 * @returns matching ids.
 */
export function idsInBox(rects: readonly CanvasRect[], box: SelectBox): readonly string[] {
  return rects.filter(rect => boxesOverlap(rect, box)).map(rect => rect.id)
}

/** Axis-aligned bounds of the placed tiles. */
export function canvasBounds(rects: readonly CanvasRect[]): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  if (rects.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const rect of rects) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.w)
    maxY = Math.max(maxY, rect.y + rect.h)
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Where the camera has to sit for a board's tiles to be on screen when its
 * project opens.
 *
 * Saved positions are absolute and shared by every viewport, so an arrangement
 * made on a wide screen sits far below and to the right of a phone's canvas.
 * Opening at a fixed origin showed a dotted, empty board with no hint that
 * anything was there: the tiles were not missing, they were somewhere else.
 * An unarranged board has its first tile at the origin, so this returns the
 * plain inset for it and nothing moves.
 * @param rects - the laid-out tiles.
 * @param inset - space to keep at the left for the chat floating over the board.
 * @returns the camera translation to open with.
 */
export function openingCamera(
  rects: readonly CanvasRect[],
  inset: number,
): { x: number; y: number } {
  if (rects.length === 0) return { x: inset, y: 0 }
  const { minX, minY } = canvasBounds(rects)
  // A board already at the origin negates to -0, which is a distinct value in
  // JS and survives into the camera state and every equality check made on it.
  return { x: inset - minX, y: minY === 0 ? 0 : -minY }
}

/**
 * The camera that brings one tile on screen, when it is not already.
 *
 * A board laid out in generation order puts a new tile at the bottom, three
 * or five screens below the camera, and a file that lands there is reported
 * as missing. The tile is pinned to the top-left of the board, past the chat.
 * @param rect - the tile to show.
 * @param camera - the current translation.
 * @param zoom - the current zoom.
 * @param board - the visible board, in screen pixels.
 * @param inset - space to keep at the left for the chat floating over the board.
 * @returns the camera to set, or undefined when the tile is already fully on screen.
 */
export function revealCamera(
  rect: CanvasRect,
  camera: { x: number; y: number },
  zoom: number,
  board: { width: number; height: number },
  inset: number,
): { x: number; y: number } | undefined {
  const left = camera.x + rect.x * zoom
  const top = camera.y + rect.y * zoom
  const inside = left >= 0 && left + rect.w * zoom <= board.width
    && top >= 0 && top + rect.h * zoom <= board.height
  if (inside) return undefined
  return { x: inset - rect.x * zoom, y: 24 - rect.y * zoom }
}

/**
 * The order tiles are packed in: oldest first, tiles still generating last.
 *
 * The gallery lists files newest first — which is what the History rail wants
 * — so taking that order into the layout packed every new generation at the
 * top of the board and pushed the work already there down.
 * @param newestFirst - visible media names, newest first.
 * @param liveJobIds - ids of jobs still generating.
 * @returns one id list for `layoutCanvas`.
 */
export function canvasOrder(
  newestFirst: readonly string[],
  liveJobIds: readonly string[],
): readonly string[] {
  return [...[...newestFirst].reverse(), ...liveJobIds]
}

/**
 * Where a multi-selection's own bar sits: centred under the picked tiles.
 *
 * The gap is divided by the zoom because the bar counter-scales against it:
 * the distance is wanted in screen pixels, and everything else here is in
 * canvas ones.
 * @param rects - the live rects of the picked tiles.
 * @param zoom - the board's current zoom.
 * @param gap - screen pixels between the selection and the bar.
 * @returns the anchor point, or undefined when fewer than two tiles are picked.
 */
export function selectionBarAnchor(
  rects: readonly CanvasRect[],
  zoom: number,
  gap = 12,
): { x: number; y: number } | undefined {
  if (rects.length < 2) return undefined
  const bounds = canvasBounds(rects)
  return { x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY + gap / zoom }
}

/**
 * Which run each file belongs to: files of one kind made one after the other,
 * no further apart than the kind's gap, share a run — a generation's
 * variants, a lookbook's poses, a batch of uploads. The board lays a run out
 * as one row, and All media groups by it.
 * @param items - the files, in any order.
 * @param keyOf - the kind a file is grouped by; a change of kind starts a run.
 * @param gapOf - the longest gap within one run, by kind, in milliseconds.
 * @param fixedOf - a group a file belongs to whatever the gaps (a story's
 *   shots), or undefined; a file after one of those starts a new run.
 * @returns the run id of every file, by name: the name of the run's first file,
 *   or the fixed group.
 */
export function runGroups<T extends { readonly name: string; readonly mtime: number }>(
  items: readonly T[],
  keyOf: (item: T) => string,
  gapOf: (key: string) => number,
  fixedOf: (item: T) => string | undefined = () => undefined,
): Map<string, string> {
  const out = new Map<string, string>()
  let previous: T | undefined
  let previousKey = ''
  let run = ''
  for (const item of [...items].sort((a, b) => a.mtime - b.mtime)) {
    const key = keyOf(item)
    const fixed = fixedOf(item)
    if (fixed !== undefined) {
      out.set(item.name, fixed)
    } else {
      if (previous === undefined || key !== previousKey || item.mtime - previous.mtime > gapOf(key)
        || fixedOf(previous) !== undefined) run = item.name
      out.set(item.name, run)
    }
    previous = item
    previousKey = key
  }
  return out
}
