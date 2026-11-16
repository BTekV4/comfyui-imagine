/**
 * «Colors» and «Draw» in the viewer's column, as Grok's post page
 * (2026-11-15): a palette taken from the photo or picked from ten, applied
 * as one edit; a sketch drawn over the photo in colour, finished in a style.
 * @module PostTools
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { translate } from './locale-store.ts'
import { DRAW_STYLES, PALETTE_PRESETS, mainColors, type DrawStyleId } from '../../../shared/imagine-post-tools.ts'
import { Segmented } from './Pills.tsx'
import { IconPencil } from './canvas-icons.tsx'
import css from './PostPanel.module.css'

/* ── «Colors» ─────────────────────────────────────────────────────────────── */

/** The main colours of the shown photo, read off a small copy of it. */
export function photoColors(image: HTMLImageElement | null): string[] {
  if (image === null || image.naturalWidth === 0) return []
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = Math.max(1, Math.round(64 * image.naturalHeight / image.naturalWidth))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return []
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  try {
    return mainColors(context.getImageData(0, 0, canvas.width, canvas.height).data)
  } catch {
    return []
  }
}

export function ColorsTool({ colors, onColors, onExtract, onApply, busy }: {
  colors: readonly string[]
  onColors: (next: readonly string[]) => void
  onExtract: () => void
  onApply: () => void
  busy: boolean
}) {
  return (
    <div className={css.section} style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto' }}>
      <span className={css.sectionTitle}>{translate('imagine.palette')}</span>
      <div className={css.paletteStrip}>
        {colors.map((color, at) => (
          <label key={`${String(at)}-${color}`} className={css.swatch} style={{ background: color }} title={translate('imagine.paletteEdit', { hex: color })}>
            <input type="color" value={color.toLowerCase()} aria-label={translate('imagine.paletteEdit', { hex: color })} onChange={(event) => { onColors(colors.map((other, k) => (k === at ? event.currentTarget.value.toUpperCase() : other))) }} />
            {colors.length > 1 && (
              <button
                type="button"
                className={css.swatchRemove}
                aria-label={translate('imagine.paletteRemove', { hex: color })}
                title={translate('imagine.paletteRemove', { hex: color })}
                onClick={(event) => { event.preventDefault(); onColors(colors.filter((_, k) => k !== at)) }}
              >×</button>
            )}
          </label>
        ))}
      </div>
      <button type="button" className={css.softButton} onClick={onExtract}>
        <IconPencil size={14} strokeWidth={2} />
        {translate('imagine.paletteExtract')}
      </button>
      <span className={css.sectionTitle} style={{ fontSize: 12, paddingTop: 6 }}>{translate('imagine.paletteExplore')}</span>
      <div className={css.presets}>
        {PALETTE_PRESETS.map(preset => (
          <button key={preset.id} type="button" className={css.preset} onClick={() => { onColors(preset.colors) }}>
            <span className={css.presetStrip}>{preset.colors.map(color => <span key={color} style={{ background: color }} />)}</span>
            <span className={css.presetName}>{translate(`imagine.palette.${preset.id}`)}</span>
          </button>
        ))}
      </div>
      <button type="button" className={css.applyButton} disabled={busy || colors.length === 0} onClick={onApply}>
        {translate('imagine.paletteApply')}
      </button>
    </div>
  )
}

/* ── «Draw» ────────────────────────────────────────────────────────────── */

/** The two drawing tools of the switch. */
const DRAW_TOOLS = ['brush', 'eraser'] as const

/** Grok's colours for the brush. */
const DRAW_COLORS = ['#FFFFFF', '#000000', '#EF4444', '#F97316', '#FACC15', '#22C55E', '#3B82F6'] as const

interface Stroke {
  readonly color: string
  /** Width as a share of the photo's width. */
  readonly size: number
  readonly erase: boolean
  readonly points: [number, number][]
}

/** The long side the sketch is shown at. */
const SKETCH_SIDE = 1024

/**
 * A sketch over the photo, kept as strokes so «undo» and «redo» work,
 * flattened onto the photo when it is sent.
 */
export function useSketch() {
  const ref = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<Stroke[]>([])
  const undone = useRef<Stroke[]>([])
  const live = useRef<Stroke | undefined>(undefined)
  const [count, setCount] = useState(0)
  const [redoable, setRedoable] = useState(0)

  const paint = (context: CanvasRenderingContext2D, list: readonly Stroke[], width: number, height: number, widen = 1, ink?: string): void => {
    for (const stroke of list) {
      if (stroke.points.length === 0) continue
      context.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over'
      context.strokeStyle = ink ?? stroke.color
      context.lineWidth = stroke.size * width * widen
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.beginPath()
      const [first, ...rest] = stroke.points
      context.moveTo(first![0] * width, first![1] * height)
      if (rest.length === 0) context.lineTo(first![0] * width + 0.01, first![1] * height)
      for (const [x, y] of rest) context.lineTo(x * width, y * height)
      context.stroke()
    }
    context.globalCompositeOperation = 'source-over'
  }
  const redraw = (): void => {
    const node = ref.current
    const context = node?.getContext('2d')
    if (node === null || node === undefined || context === null || context === undefined) return
    context.clearRect(0, 0, node.width, node.height)
    paint(context, live.current === undefined ? strokes.current : [...strokes.current, live.current], node.width, node.height)
  }
  const sizeTo = (image: HTMLImageElement): void => {
    const node = ref.current
    if (node === null || image.naturalWidth === 0) return
    const scale = SKETCH_SIDE / Math.max(image.naturalWidth, image.naturalHeight)
    node.width = Math.round(image.naturalWidth * scale)
    node.height = Math.round(image.naturalHeight * scale)
    redraw()
  }
  const at = (event: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
    const box = event.currentTarget.getBoundingClientRect()
    return [(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height]
  }
  const handlers = (pen: { color: string; size: number; erase: boolean }, enabled: boolean) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      if (!enabled || event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      live.current = { ...pen, points: [at(event)] }
      redraw()
    },
    onPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      if (live.current === undefined) return
      live.current.points.push(at(event))
      redraw()
    },
    onPointerUp: (): void => {
      if (live.current === undefined) return
      strokes.current = [...strokes.current, live.current]
      live.current = undefined
      undone.current = []
      setCount(strokes.current.length)
      setRedoable(0)
      redraw()
    },
  })
  const undo = (): void => {
    const last = strokes.current.at(-1)
    if (last === undefined) return
    strokes.current = strokes.current.slice(0, -1)
    undone.current = [...undone.current, last]
    setCount(strokes.current.length)
    setRedoable(undone.current.length)
    redraw()
  }
  const redo = (): void => {
    const next = undone.current.at(-1)
    if (next === undefined) return
    undone.current = undone.current.slice(0, -1)
    strokes.current = [...strokes.current, next]
    setCount(strokes.current.length)
    setRedoable(undone.current.length)
    redraw()
  }
  const clear = (): void => {
    strokes.current = []
    undone.current = []
    live.current = undefined
    setCount(0)
    setRedoable(0)
    redraw()
  }
  /** The photo with the sketch on it, at the photo's own size. */
  const flatten = async (image: HTMLImageElement): Promise<Blob> => {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('canvas')
    const ink = document.createElement('canvas')
    ink.width = canvas.width
    ink.height = canvas.height
    const inkContext = ink.getContext('2d')
    if (inkContext === null) throw new Error('canvas')
    // The strokes on their own layer, so the eraser takes ink and not the photo.
    paint(inkContext, strokes.current, ink.width, ink.height)
    context.drawImage(image, 0, 0)
    context.drawImage(ink, 0, 0)
    return await new Promise((resolve, reject) => { canvas.toBlob(blob => { if (blob === null) reject(new Error('png')); else resolve(blob) }, 'image/png') })
  }
  /** White where the sketch is, a little wider than the strokes, black elsewhere. */
  const maskOf = (width: number, height: number): string => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context === null) return ''
    const ink = document.createElement('canvas')
    ink.width = width
    ink.height = height
    const inkContext = ink.getContext('2d')
    if (inkContext === null) return ''
    paint(inkContext, strokes.current, width, height, 2.2, '#fff')
    context.fillStyle = '#000'
    context.fillRect(0, 0, width, height)
    context.drawImage(ink, 0, 0)
    return canvas.toDataURL('image/png')
  }
  return { ref, count, redoable, sizeTo, handlers, undo, redo, clear, flatten, maskOf }
}

export function DrawTool({ brush, onBrush, erase, onErase, color, onColor, style, onStyle, inked, busy, onGenerate }: {
  brush: number
  onBrush: (size: number) => void
  erase: boolean
  onErase: (erase: boolean) => void
  color: string
  onColor: (color: string) => void
  style: DrawStyleId
  onStyle: (style: DrawStyleId) => void
  inked: boolean
  busy: boolean
  onGenerate: () => void
}) {
  const dropper = typeof window !== 'undefined' && 'EyeDropper' in window
  return (
    <div className={css.section} style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto' }}>
      <span className={css.sectionTitle}>{translate('imagine.brushSize')}</span>
      <div className={css.slider}>
        <span className={css.dotSmall} aria-hidden="true" />
        <input type="range" min={2} max={48} step={1} value={brush} aria-label={translate('imagine.brushSize')} onChange={(event) => { onBrush(Number(event.currentTarget.value)) }} />
        <span className={css.dotLarge} aria-hidden="true" />
      </div>
      <Segmented
        label={translate('imagine.drawTool')}
        values={DRAW_TOOLS}
        value={erase ? 'eraser' : 'brush'}
        onPick={(tool) => { onErase(tool === 'eraser') }}
        format={tool => translate(tool === 'eraser' ? 'imagine.eraser' : 'imagine.brush')}
        group={css.segmented}
        pill={css.segment}
      />
      <span className={css.sectionTitle}>{translate('imagine.drawColors')}</span>
      <div className={css.colorRow}>
        {DRAW_COLORS.map(entry => (
          <button
            key={entry}
            type="button"
            className={css.colorDot}
            style={{ background: entry }}
            aria-label={translate('imagine.drawUseColor', { hex: entry })}
            aria-pressed={!erase && color.toUpperCase() === entry}
            onClick={() => { onColor(entry); onErase(false) }}
          />
        ))}
        <label className={css.colorDot} style={{ background: 'conic-gradient(#ef4444, #facc15, #22c55e, #3b82f6, #a855f7, #ef4444)' }} title={translate('imagine.drawCustomColor')}>
          <input type="color" value={color.toLowerCase()} aria-label={translate('imagine.drawCustomColor')} onChange={(event) => { onColor(event.currentTarget.value.toUpperCase()); onErase(false) }} />
        </label>
        {dropper && (
          <button
            type="button"
            className={css.colorDot}
            data-tool
            aria-label={translate('imagine.drawPickColor')}
            title={translate('imagine.drawPickColor')}
            onClick={() => {
              const Picker = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
              new Picker().open().then((picked) => { onColor(picked.sRGBHex.toUpperCase()); onErase(false) }, () => undefined)
            }}
          >
            <IconPencil size={14} strokeWidth={2} />
          </button>
        )}
      </div>
      <span className={css.sectionTitle}>{translate('imagine.drawStyle')}</span>
      <select className={css.select} value={style} aria-label={translate('imagine.drawStyle')} onChange={(event) => { onStyle(event.currentTarget.value as DrawStyleId) }}>
        {DRAW_STYLES.map(entry => <option key={entry.id} value={entry.id}>{translate(`imagine.drawStyle.${entry.id}`)}</option>)}
      </select>
      <p className={css.hint}>{inked ? translate('imagine.drawReady') : translate('imagine.drawHint')}</p>
      <button type="button" className={css.applyButton} disabled={busy || !inked} onClick={onGenerate}>
        {translate('imagine.drawGenerate')}
      </button>
    </div>
  )
}
