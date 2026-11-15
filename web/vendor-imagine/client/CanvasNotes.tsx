/**
 * Text boxes on the canvas, as Grok Imagine's "Text" (read off its page
 * 2026-10-17): plain text on the board, 16px and 360 wide when placed. A
 * click selects one — a white frame, side handles for the width, and a bar
 * above with the font size, the colour, the alignment and delete. A double
 * click writes in it.
 *
 * A drag moves the box locally and is saved once, on release: every store
 * write rewrites the whole project, and one per pointer move froze the board.
 */
import { translate } from './locale-store.ts'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { CanvasNote } from '../../../shared/imagine-projects.ts'
import type { ComfyLocaleKey } from './locales.ts'
import { IconBin } from '../../shims/primitives/index.ts'
import css from './CanvasNotes.module.css'

/** The label of each alignment button. */
const ALIGN_KEYS: Readonly<Record<'left' | 'center' | 'right', ComfyLocaleKey>> = {
  left: 'imagine.noteAlignLeft',
  center: 'imagine.noteAlignCenter',
  right: 'imagine.noteAlignRight',
}

/** Grok's font sizes. */
const NOTE_SIZES = [8, 12, 14, 16, 18, 24, 32, 48, 64, 96] as const
/** Grok's colours; undefined is the theme's own ink. */
const NOTE_COLORS: readonly { label: string; value: string }[] = [
  { label: 'Bianco', value: '#FFFFFF' },
  { label: 'Nero', value: '#0A0A0A' },
  { label: 'Grigio', value: '#9CA3AF' },
  { label: 'Rosso', value: '#EF4444' },
  { label: 'Arancione', value: '#F97316' },
  { label: 'Giallo', value: '#EAB308' },
  { label: 'Verde', value: '#22C55E' },
  { label: 'Blu', value: '#3B82F6' },
  { label: 'Viola', value: '#A855F7' },
  { label: 'Rosa', value: '#EC4899' },
]

export function newNote(x: number, y: number): CanvasNote {
  return { id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: '', x, y, w: 360, size: 16 }
}

export interface CanvasNoteViewProps {
  readonly note: CanvasNote
  readonly zoom: number
  readonly selected: boolean
  readonly editing: boolean
  readonly onSelect: () => void
  readonly onEdit: (editing: boolean) => void
  readonly onChange: (note: CanvasNote) => void
  readonly onDelete: () => void
}

type Drag = { kind: 'move' | 'left' | 'right'; x: number; y: number }

export function CanvasNoteView({ note, zoom, selected, editing, onSelect, onEdit, onChange, onDelete }: CanvasNoteViewProps) {
  const [draft, setDraft] = useState(note.text)
  const [shift, setShift] = useState({ dx: 0, dy: 0, dw: 0 })
  const [menu, setMenu] = useState<'size' | 'color' | undefined>(undefined)
  const drag = useRef<Drag>()
  const field = useRef<HTMLTextAreaElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const inverse = Math.max(1, 1 / zoom)

  useEffect(() => { setDraft(note.text) }, [note.text])
  useEffect(() => { if (!selected) setMenu(undefined) }, [selected])
  useEffect(() => {
    if (!editing) return
    const node = field.current
    node?.focus()
    node?.setSelectionRange(node.value.length, node.value.length)
    // The board prevents the default on its own pointerdown (it starts a
    // marquee), so a click on it never took the focus off the field and the
    // box stayed open, unsaved. Any press outside the box ends the edit.
    const onDown = (event: PointerEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) node?.blur()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => { window.removeEventListener('pointerdown', onDown, true) }
  }, [editing])

  const start = (kind: Drag['kind']) => (event: ReactPointerEvent<HTMLElement>): void => {
    // The board's own pointerdown starts a selection marquee.
    event.stopPropagation()
    if (event.button !== 0) return
    onSelect()
    if (editing && kind === 'move') return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { kind, x: event.clientX, y: event.clientY }
  }
  const move = (event: ReactPointerEvent<HTMLElement>): void => {
    const current = drag.current
    if (current === undefined) return
    const dx = (event.clientX - current.x) / zoom
    const dy = (event.clientY - current.y) / zoom
    setShift(current.kind === 'move' ? { dx, dy, dw: 0 } : current.kind === 'right' ? { dx: 0, dy: 0, dw: dx } : { dx, dy: 0, dw: -dx })
  }
  const end = (): void => {
    const current = drag.current
    if (current === undefined) return
    drag.current = undefined
    if (shift.dx !== 0 || shift.dy !== 0 || shift.dw !== 0) {
      const w = Math.max(60, note.w + shift.dw)
      // The left handle moves the left edge: the right edge stays put.
      const x = current.kind === 'left' ? note.x + note.w - w : note.x + shift.dx
      onChange({ ...note, x, y: note.y + shift.dy, w })
    }
    setShift({ dx: 0, dy: 0, dw: 0 })
  }

  const finish = (): void => {
    onEdit(false)
    const text = draft.trim()
    // A box written and emptied again is a box nobody wanted.
    if (text === '') onDelete()
    else if (text !== note.text) onChange({ ...note, text })
  }
  const set = (patch: Partial<CanvasNote>): void => { onChange({ ...note, text: editing ? draft : note.text, ...patch }) }
  const keep = (event: { preventDefault(): void; stopPropagation(): void }): void => { event.preventDefault(); event.stopPropagation() }

  const width = Math.max(60, note.w + shift.dw)
  return (
    <div
      ref={box}
      className={css.note}
      data-selected={selected || undefined}
      data-editing={editing || undefined}
      data-imagine-note
      style={{
        left: drag.current?.kind === 'left' ? note.x + note.w - width : note.x + shift.dx,
        top: note.y + shift.dy,
        width,
        fontSize: note.size,
        textAlign: note.align ?? 'left',
        ...note.color === undefined ? {} : { color: note.color },
        '--note-inv': String(inverse),
      } as CSSProperties}
      onPointerDown={start('move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={(event) => { event.stopPropagation(); onEdit(true) }}
    >
      {editing
        ? (
          <textarea
            ref={field}
            className={css.field}
            value={draft}
            rows={1}
            placeholder={translate('imagine.writeHere')}
            onChange={(event) => { setDraft(event.target.value) }}
            onBlur={finish}
            onPointerDown={(event) => { event.stopPropagation() }}
            // The canvas listens for its own shortcuts on the window.
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Escape') event.currentTarget.blur()
            }}
            onKeyUp={(event) => { event.stopPropagation() }}
          />
        )
        : <p className={css.text}>{note.text}</p>}
      {selected && (
        <>
          <span className={css.frame} aria-hidden="true" />
          <span className={css.handle} data-side="left" onPointerDown={start('left')} onPointerMove={move} onPointerUp={end} />
          <span className={css.handle} data-side="right" onPointerDown={start('right')} onPointerMove={move} onPointerUp={end} />
          <div className={css.bar} style={{ transform: `translateX(-50%) scale(${String(1 / zoom)})` }} onPointerDown={keep} onMouseDown={keep} onDoubleClick={keep}>
            <div className={css.group}>
              <button type="button" className={css.btn} aria-label={translate('imagine.textSize')} title={translate('imagine.textSize')} onClick={() => { setMenu(open => (open === 'size' ? undefined : 'size')) }}>
                <span className={css.sizeValue}>{String(note.size)}</span>
                <span className={css.caret}>▾</span>
              </button>
              {menu === 'size' && (
                <div className={css.pop} role="menu">
                  {NOTE_SIZES.map(size => (
                    <button key={size} type="button" role="menuitemradio" aria-checked={note.size === size} className={css.popItem} data-on={note.size === size || undefined} onClick={() => { set({ size }); setMenu(undefined) }}>
                      {String(size)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className={css.rule} />
            <div className={css.group}>
              <button type="button" className={css.btn} aria-label={translate('imagine.color')} title={translate('imagine.color')} onClick={() => { setMenu(open => (open === 'color' ? undefined : 'color')) }}>
                <span className={css.dot} style={{ background: note.color ?? 'var(--imagine-ink)' }} />
              </button>
              {menu === 'color' && (
                <div className={css.pop} role="menu">
                  <button type="button" className={css.popRow} onClick={() => { const { color: _gone, ...rest } = note; onChange({ ...rest, text: editing ? draft : note.text }); setMenu(undefined) }}>
                    <span className={css.dot} style={{ background: 'var(--imagine-ink)' }} />
                    Predefinito
                  </button>
                  <div className={css.swatches}>
                    {NOTE_COLORS.map(entry => (
                      <button key={entry.value} type="button" className={css.swatch} aria-label={entry.label} title={entry.label} data-on={note.color === entry.value || undefined} onClick={() => { set({ color: entry.value }); setMenu(undefined) }}>
                        <span className={css.dot} style={{ background: entry.value }} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <span className={css.rule} />
            {(['left', 'center', 'right'] as const).map(align => (
              <button
                key={align}
                type="button"
                className={css.btn}
                data-on={(note.align ?? 'left') === align || undefined}
                aria-label={translate(ALIGN_KEYS[align])}
                title={translate(ALIGN_KEYS[align])}
                onClick={() => { set({ align }) }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <path d={align === 'left' ? 'M2 3h10M2 7h6M2 11h8' : align === 'center' ? 'M2 3h10M4 7h6M3 11h8' : 'M2 3h10M6 7h6M4 11h8'} />
                </svg>
              </button>
            ))}
            <span className={css.rule} />
            <button type="button" className={css.btn} aria-label={translate('imagine.delete')} title={translate('imagine.delete')} onClick={onDelete}>
              <IconBin strokeWidth={2.4} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}
