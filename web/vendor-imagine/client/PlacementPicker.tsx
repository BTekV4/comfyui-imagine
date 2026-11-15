/**
 * Where the new object of "Object swap" → "Add an object" appears.
 *
 * The box is the graph's mask: where there is no box there is no object.
 * It is picked with just two gestures — a cell of the 3×3 grid for the
 * position, a pill for the size — instead of dragging a rectangle over the
 * video: the panel is also used with a thumb, at 390 px, and a drag on a
 * thumbnail is the easiest gesture to get wrong (2026-11-06).
 * @module PlacementPicker
 */

import type { ComfyLocaleKey } from './locales.ts'
import { type ImaginePlacement } from '../../../shared/imagine-types.ts'
import css from './PlacementPicker.module.css'
import { translate } from './locale-store.ts'

/** The three sizes offered, as the box's side (fraction of the frame). */
const SIZES: readonly { readonly id: string; readonly side: number; readonly key: ComfyLocaleKey }[] = [
  { id: 'small', side: 0.2, key: 'imagine.placementSmall' },
  { id: 'medium', side: 0.32, key: 'imagine.placementMedium' },
  { id: 'large', side: 0.46, key: 'imagine.placementLarge' },
]

/** Margin from the edge when the box is in a corner, as a fraction. */
const EDGE = 0.06

const ROWS = ['imagine.placementTop', 'imagine.placementMiddle', 'imagine.placementBottom'] as const
const COLS = ['imagine.placementLeft', 'imagine.placementCentre', 'imagine.placementRight'] as const

/**
 * The box matching a cell and a size.
 * @param row - 0 top, 1 middle, 2 bottom.
 * @param col - 0 left, 1 centre, 2 right.
 * @param side - the box's side, as a fraction of the frame.
 * @returns the normalised box.
 */
function boxOf(row: number, col: number, side: number): ImaginePlacement {
  const x = col === 0 ? EDGE : col === 2 ? 1 - side - EDGE : (1 - side) / 2
  const y = row === 0 ? EDGE : row === 2 ? 1 - side - EDGE : (1 - side) / 2
  const round = (value: number): number => Math.round(value * 1000) / 1000
  return { x: round(x), y: round(y), width: side, height: side }
}

/**
 * Which cell and which size describe a box.
 *
 * The box is read back from its geometry instead of being remembered: the
 * page holds a single `placement`, and this control has no state of its own.
 * @param placement - the current box.
 * @returns the cell, size and side that resemble it most.
 */
function nearest(placement: ImaginePlacement): { row: number; col: number; side: number } {
  const side = SIZES.reduce<number>(
    (best, size) => (Math.abs(size.side - placement.width) < Math.abs(best - placement.width) ? size.side : best),
    SIZES[0]!.side,
  )
  const room = 1 - side
  const col = Math.max(0, Math.min(2, Math.round((placement.x - EDGE) / Math.max(0.001, room - 2 * EDGE) * 2)))
  const row = Math.max(0, Math.min(2, Math.round((placement.y - EDGE) / Math.max(0.001, room - 2 * EDGE) * 2)))
  return { row, col, side }
}

export interface PlacementPickerProps {
  /** The current box. */
  readonly value: ImaginePlacement
  /** A new box was picked. */
  readonly onChange: (value: ImaginePlacement) => void
}

/**
 * The position grid and the size pills.
 * @param props - the box and what to do when it changes.
 * @returns the control.
 */
export function PlacementPicker(props: PlacementPickerProps) {
  const { row, col, side } = nearest(props.value)
  return (
    <div className={css.picker}>
      <span className={css.title}>{translate('imagine.placementTitle')}</span>
      <p className={css.hint}>{translate('imagine.placementHint')}</p>
      <div className={css.grid} role="group" aria-label={translate('imagine.placementTitle')}>
        {ROWS.map((rowKey, r) => COLS.map((colKey, c) => (
          <button
            key={`${r}-${c}`}
            type="button"
            className={r === row && c === col ? `${css.cell} ${css.cellOn}` : css.cell}
            aria-pressed={r === row && c === col}
            aria-label={`${translate(rowKey)}, ${translate(colKey)}`}
            onClick={() => { props.onChange(boxOf(r, c, side)) }}
          />
        )))}
      </div>
      <div className={css.sizes} role="group" aria-label={translate('imagine.placementSize')}>
        {SIZES.map(size => (
          <button
            key={size.id}
            type="button"
            className={size.side === side ? `${css.size} ${css.sizeOn}` : css.size}
            aria-pressed={size.side === side}
            onClick={() => { props.onChange(boxOf(row, col, size.side)) }}
          >
            {translate(size.key)}
          </button>
        ))}
      </div>
    </div>
  )
}
