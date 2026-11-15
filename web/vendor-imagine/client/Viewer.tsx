/**
 * The studio's viewer, laid out as Grok Imagine's post page (studied live on
 * 2026-11-15, docs/note/imagine-grok-post-riferimento.md): «back» at the top
 * left, the zoom over the middle, the file as large as the stage allows with
 * the edit bar under it, and on the right the post's column — the tools
 * along its top (Segmenti, Modifica precisa, Colori, Ritaglia, Disegna), the open tool, the
 * actions and a row of icons. The tools work on the photo itself: no dialog.
 * There is no strip of neighbours any more, as on Grok; ← and → step through
 * them. Split out of ImaginePage.tsx on 2026-10-20.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { IconBack, IconPlayOutlineRegular } from '../../shims/primitives/index.ts'
import { mediaUrlOf } from './gallery-api.ts'
import type { GalleryItem, ImagineRegion } from '../../../shared/imagine-types.ts'
import { formatClock } from './format.ts'
import { QualityBadge } from './imagine-bits.tsx'
import { mediaActions, type MediaActionKind } from './media-actions.tsx'
import { useMediaTransport } from './media-playback.ts'
import { useMaskPainter } from './mask-painter.ts'
import { messageOf } from './message-of.ts'
import { useHostEdit } from './Modal.tsx'
import { PostCrop } from './PostCrop.tsx'
import { PostPanel, PreciseTool, type PostTool } from './PostPanel.tsx'
import { ColorsTool, DrawTool, photoColors, useSketch } from './PostTools.tsx'
import { drawPrompt, palettePrompt, type DrawStyleId } from '../../../shared/imagine-post-tools.ts'
import { joinedMask, segmentUnder, useMaskBits, useSegments } from './segments-api.ts'
import { editBoxPlace, SegmentBoxes, SegmentEditBox, SegmentHint, SegmentLabel, SegmentsPanel, useDrawnBox } from './SegmentsPanel.tsx'
import { SEGMENT_REMOVE_PROMPT, textEditPrompt, type TextEditDraft } from '../../../shared/imagine-segments.ts'
import { Still } from './Still.tsx'
import { isTypingTarget } from './typing.ts'
import { ViewerPrompt, type FileOrigin } from './ViewerPrompt.tsx'
import shared from './imagine-shared.module.css'
import css from './Viewer.module.css'
import { translate } from './locale-store.ts'

/** The zoom steps of the "− 100% +" control, as Grok Imagine has it. */
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const

/** Where the viewer remembers that its column was folded away. */
const PANEL_KEY = 'imagine.viewer.panel'

/** A pointer that moved less than this between press and release clicked. */
const CLICK_SLOP = 4

/** The long side «Modifica precisa» paints at; the host scales the mask to the photo. */
const PAINT_SIDE = 1024

/** Whether the column was left folded; storage may be off. */
function panelWasFolded(): boolean {
  try { return localStorage.getItem(PANEL_KEY) === '0' } catch { return false }
}

export function Viewer({
  items, current, busy, liked, onPick, onClose, onAction, onRerun, onAsk, onRegion, onEdit, onCropped, onSketch,
}: {
  items: readonly GalleryItem[]
  current: GalleryItem
  busy: boolean
  /** Whether this file has a "Like". */
  liked: boolean
  onPick: (item: GalleryItem) => void
  onClose: () => void
  /** Run one of the file's actions; `anchor` is the button that asked. */
  onAction: (kind: MediaActionKind, item: GalleryItem, anchor?: DOMRect) => void
  /** Make a clip again with an edited prompt (the bar under it). */
  onRerun: (origin: FileOrigin, prompt: string) => void
  /** Ask the project chat about this file. */
  onAsk: (text: string) => void
  /** Precise edit of a zone (painted, or the picked parts), on its mask; Grok's «+» reference with it. */
  onRegion: (photo: GalleryItem, prompt: string, zone: { mask: string }, reference?: File) => void
  /** Edit the whole photo with the words in the bar, and the reference photo when one was added. */
  onEdit: (photo: GalleryItem, prompt: string, reference?: File) => void
  /** «Ritaglia» made a new file. */
  onCropped: (item: GalleryItem) => void
  /** «Disegna»: the photo with the sketch on it, the sketch's zone and the words. */
  onSketch: (photo: GalleryItem, sketch: Blob, mask: string, prompt: string) => void
}) {
  const transport = useMediaTransport(0)
  const { playing, currentTime } = transport
  const duration = transport.duration ?? 0
  const videoRef = transport.ref
  const { reset } = transport
  useEffect(() => { reset(0) }, [current.name])

  const image = current.kind === 'image'
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [folded, setFolded] = useState(panelWasFolded)
  const [tool, setTool] = useState<PostTool>('segments')
  // Another file opens fitted, on Grok's first tool.
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); setTool('segments') }, [current.name])
  const stepZoom = (direction: 1 | -1): void => {
    setZoom((now) => {
      const at = ZOOMS.findIndex(value => value >= now - 1e-6)
      const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (at < 0 ? ZOOMS.length - 1 : at) + direction))] ?? 1
      if (next <= 1) setPan({ x: 0, y: 0 })
      return next
    })
  }
  const fold = (next: boolean): void => {
    setFolded(next)
    try { localStorage.setItem(PANEL_KEY, next ? '0' : '1') } catch { /* remembered for this visit only */ }
  }

  // ← and → step through the files, as the strip that is gone did.
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || isTypingTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey) return
      const at = items.findIndex(item => item.name === current.name)
      const next = items[at + (event.key === 'ArrowLeft' ? -1 : 1)]
      if (at < 0 || next === undefined) return
      event.preventDefault()
      onPickRef.current(next)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [items, current.name])

  const frameRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const drawn = useDrawnBox(imageRef, `${String(zoom)} ${String(pan.x)} ${String(pan.y)} ${String(folded)} ${tool} ${current.name}`)

  /*
   * «Segmenti», as on Grok (docs/note/imagine-grok-segmenti-riferimento.md):
   * white boxes over the photo, the part's name following the cursor and
   * the edit box under what is picked. A click picks one part, Shift+click
   * adds or removes, a click on nothing or outside lets go.
   */
  const segmentsOn = image && !folded && tool === 'segments'
  const segments = useSegments(image && !folded ? current.name : undefined)
  const index = segments.status?.state === 'ready' ? segments.status.index : undefined
  const bits = useMaskBits(segmentsOn ? index : undefined)
  const [picked, setPicked] = useState<readonly number[]>([])
  const [hover, setHover] = useState<number>()
  const [groupHover, setGroupHover] = useState<readonly number[]>()
  const [reveal, setReveal] = useState<{ readonly index: number }>()
  const [cursor, setCursor] = useState<{ x: number; y: number }>()
  const [prompt, setPrompt] = useState('')
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string>()
  const letGo = (): void => { setPicked([]); setPrompt(''); setJoinError(undefined) }
  useEffect(() => { letGo(); setHover(undefined); setGroupHover(undefined); setCursor(undefined) }, [current.name, index?.createdAt, tool])
  const pickPart = (id: number, add: boolean): void => {
    setJoinError(undefined)
    if (!add) { setPicked([id]); setPrompt(''); return }
    setPicked(now => (now.includes(id) ? now.filter(other => other !== id) : [...now, id]))
  }
  const removePart = (id: number): void => { setPicked([id]); setPrompt(SEGMENT_REMOVE_PROMPT); setJoinError(undefined) }
  useEffect(() => {
    if (picked.length === 0) return
    const onDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (target === null || frameRef.current?.contains(target) === true || target.closest('[data-segment-ui]') !== null) return
      letGo()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => { window.removeEventListener('pointerdown', onDown, true) }
  }, [picked.length])
  const partUnder = (clientX: number, clientY: number): number | undefined => {
    const node = imageRef.current
    if (!segmentsOn || index === undefined || node === null) return undefined
    const box = node.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return undefined
    return segmentUnder(index.segments, bits, (clientX - box.left) / box.width, (clientY - box.top) / box.height)
  }
  const pickedParts = index?.segments.filter(segment => picked.includes(segment.index)) ?? []
  const applyParts = async (text: string, draft: TextEditDraft | undefined, reference: File | undefined): Promise<void> => {
    if (index === undefined || pickedParts.length === 0) return
    const words = draft !== undefined && pickedParts[0] !== undefined ? textEditPrompt(pickedParts[0].label, draft, text) : text
    if (words.length === 0) return
    setJoining(true)
    setJoinError(undefined)
    try {
      const mask = await joinedMask(index, pickedParts)
      letGo()
      onRegion(current, words, { mask }, reference)
    } catch (error: unknown) {
      setJoinError(messageOf(error))
    } finally {
      setJoining(false)
    }
  }

  /*
   * «Modifica precisa», as on Grok: a brush whose size is set in the column,
   * painted straight onto the photo; the bar under it then edits that zone.
   */
  const [brush, setBrush] = useState(44)
  const preciseOn = image && !folded && tool === 'precise'
  const painter = useMaskPainter({
    side: PAINT_SIDE,
    color: '#ffffff',
    // The column's size is in screen pixels; the painter takes a share of the width.
    brush: drawn !== undefined && drawn.width > 0 ? brush / drawn.width * 100 : 4,
    erase: false,
  })
  useEffect(() => { painter.clear() }, [current.name])
  useEffect(() => {
    if (preciseOn && imageRef.current !== null && imageRef.current.naturalWidth > 0) painter.sizePaint(imageRef.current)
  }, [preciseOn, current.name])

  /* «Ritaglia» on the photo: a new file beside the original. */
  const crop = useHostEdit<GalleryItem>('/api/crop-copy', 'HTTP')
  const cropOn = image && !folded && tool === 'crop'

  /* «Colori»: the photo's own four colours to start from, or one of ten palettes. */
  const colorsOn = image && !folded && tool === 'colors'
  const [colors, setColors] = useState<readonly string[]>([])
  useEffect(() => { if (colorsOn) setColors(photoColors(imageRef.current)) }, [colorsOn, current.name])

  /* «Disegna»: a sketch in colour over the photo, finished in a style. */
  const drawOn = image && !folded && tool === 'draw'
  const sketch = useSketch()
  const [drawBrush, setDrawBrush] = useState(12)
  const [drawErase, setDrawErase] = useState(false)
  const [drawColor, setDrawColor] = useState('#FFFFFF')
  const [drawStyle, setDrawStyle] = useState<DrawStyleId>('photo')
  const [sketching, setSketching] = useState(false)
  useEffect(() => { sketch.clear() }, [current.name])
  useEffect(() => {
    if (drawOn && imageRef.current !== null && imageRef.current.naturalWidth > 0) sketch.sizeTo(imageRef.current)
  }, [drawOn, current.name])
  const sendSketch = async (words: string): Promise<void> => {
    const node = imageRef.current
    if (node === null || sketch.count === 0 || sketching) return
    setSketching(true)
    try {
      const blob = await sketch.flatten(node)
      const mask = sketch.maskOf(node.naturalWidth, node.naturalHeight)
      sketch.clear()
      onSketch(current, blob, mask, drawPrompt(drawStyle, words))
    } finally {
      setSketching(false)
    }
  }

  /** The bar under the photo: the painted zone or the sketch when there is one, else the photo. */
  const editPhoto = (text: string, reference?: File): void => {
    if (drawOn && sketch.count > 0) { void sendSketch(text); return }
    if (preciseOn && painter.painted && painter.hasPaint()) {
      const mask = painter.maskOf()
      if (mask !== undefined) {
        painter.clear()
        onRegion(current, text, { mask }, reference)
        return
      }
    }
    onEdit(current, text, reference)
  }

  const pressedAt = useRef<{ x: number; y: number }>()
  /** Drag to move a zoomed file around; a fitted one does not move. */
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | undefined>(undefined)
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    pressedAt.current = { x: event.clientX, y: event.clientY }
    if (zoom <= 1 || event.button !== 0 || preciseOn || cropOn || drawOn) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, y: event.clientY, from: pan }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = drag.current
    if (start === undefined) {
      if (segmentsOn && index !== undefined) {
        setCursor({ x: event.clientX, y: event.clientY })
        const under = partUnder(event.clientX, event.clientY)
        if (under !== hover) setHover(under)
      }
      return
    }
    setPan({ x: start.from.x + (event.clientX - start.x) / zoom, y: start.from.y + (event.clientY - start.y) / zoom })
  }
  const endDrag = (): void => { drag.current = undefined }
  const transform = zoom === 1 && pan.x === 0 && pan.y === 0
    ? undefined
    : { transform: `scale(${String(zoom)}) translate(${String(pan.x)}px, ${String(pan.y)}px)` }

  const actions = mediaActions(current, 'viewer', { busy, liked })
  const paintBox = drawn !== undefined && frameRef.current !== null
    ? (() => {
      const origin = frameRef.current.getBoundingClientRect()
      return { left: drawn.left - origin.left, top: drawn.top - origin.top, width: drawn.width, height: drawn.height }
    })()
    : undefined

  return (
    <div className={css.viewer} data-folded={folded || undefined} role="dialog" aria-modal="true" aria-label={translate('imagine.viewer')}>
      <header className={css.bar}>
        <button type="button" className={css.round} aria-label={translate('imagine.close')} title={translate('imagine.close')} onClick={onClose}>
          <IconBack />
        </button>
        {current.kind !== 'audio' && (
          <div className={css.zoom} role="group" aria-label={translate('imagine.zoom')}>
            <button type="button" className={css.zoomStep} aria-label={translate('imagine.zoomOut')} disabled={zoom <= ZOOMS[0] || cropOn} onClick={() => { stepZoom(-1) }}>−</button>
            <button type="button" className={css.zoomValue} title={translate('imagine.zoomReset')} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" className={css.zoomStep} aria-label={translate('imagine.zoomIn')} disabled={zoom >= ZOOMS[ZOOMS.length - 1] || cropOn} onClick={() => { stepZoom(1) }}>+</button>
          </div>
        )}
        <button
          type="button"
          className={css.round}
          aria-label={folded ? translate('imagine.expandPanel') : translate('imagine.collapsePanel')}
          title={folded ? translate('imagine.expandPanel') : translate('imagine.collapsePanel')}
          aria-pressed={!folded}
          onClick={() => { fold(!folded) }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" />{!folded && <path d="M17.5 8.5h1M17.5 12h1" strokeLinecap="round" />}</svg>
        </button>
      </header>
      <div className={css.viewerStage}>
        <div
          ref={frameRef}
          className={css.viewerFrame}
          data-zoomed={zoom > 1 || undefined}
          data-picking={(segmentsOn && hover !== undefined) || undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => { setHover(undefined); setCursor(undefined) }}
          onClick={(event) => {
            if (!segmentsOn || index === undefined) return
            const pressed = pressedAt.current
            if (pressed !== undefined && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > CLICK_SLOP) return
            const hit = partUnder(event.clientX, event.clientY)
            if (hit === undefined) { letGo(); return }
            pickPart(hit, event.shiftKey || picked.includes(hit))
            setReveal({ index: hit })
          }}
          onDoubleClick={() => { if (image && folded) { setZoom(now => (now === 1 ? 2 : 1)); setPan({ x: 0, y: 0 }) } }}
        >
          {image && (
            <Still
              className={css.viewerMedia}
              style={transform}
              src={`${mediaUrlOf(current.name)}?v=${String(current.mtime)}`}
              imageRef={imageRef}
              onLoaded={() => {
                if (imageRef.current === null) return
                if (preciseOn) painter.sizePaint(imageRef.current)
                if (drawOn) sketch.sizeTo(imageRef.current)
                if (colorsOn) setColors(photoColors(imageRef.current))
              }}
              urgent
            />
          )}
          {current.kind === 'video' && (
            <video
              ref={videoRef as RefObject<HTMLVideoElement>}
              className={css.viewerMedia}
              style={transform}
              src={mediaUrlOf(current.name)}
              autoPlay
              // The clip opened full size loops on its own (requested 2026-11-03).
              loop
              playsInline
              {...transport.events}
            />
          )}
          {current.kind === 'audio' && (
            <audio ref={videoRef} className={css.viewerAudio} src={mediaUrlOf(current.name)} autoPlay {...transport.events} />
          )}
          {segmentsOn && index !== undefined && drawn !== undefined && (
            <SegmentBoxes
              index={index}
              drawn={drawn}
              frame={frameRef}
              shown={[...hover === undefined ? [] : [hover], ...picked, ...groupHover ?? []]}
              group={groupHover}
            />
          )}
          {preciseOn && (
            <canvas
              ref={painter.ref}
              className={css.paint}
              style={paintBox}
              {...painter.handlers(!busy)}
            />
          )}
          {drawOn && (
            <>
              <canvas
                ref={sketch.ref}
                className={css.sketch}
                style={paintBox}
                {...sketch.handlers({ color: drawColor, size: drawn !== undefined && drawn.width > 0 ? drawBrush / drawn.width : 0.01, erase: drawErase }, !busy && !sketching)}
              />
              <div className={css.sketchTools}>
                <button type="button" className={css.round} aria-label={translate('imagine.undo')} title={translate('imagine.undo')} disabled={sketch.count === 0} onClick={sketch.undo}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>
                </button>
                <button type="button" className={css.round} aria-label={translate('imagine.redo')} title={translate('imagine.redo')} disabled={sketch.redoable === 0} onClick={sketch.redo}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></svg>
                </button>
                <button type="button" className={css.round} aria-label={translate('imagine.clearAll')} title={translate('imagine.clearAll')} disabled={sketch.count === 0} onClick={sketch.clear}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
                </button>
              </div>
            </>
          )}
          {cropOn && drawn !== undefined && (
            <PostCrop
              drawn={drawn}
              frame={frameRef.current}
              busy={crop.busy}
              error={crop.error}
              onCancel={() => { setTool('segments') }}
              onCrop={(region: ImagineRegion) => { void crop.run({ name: current.name, region }, (item) => { setTool('segments'); onCropped(item) }) }}
            />
          )}
        </div>
        {current.kind !== 'image' && (
          <div className={css.viewerScrub}>
            <button type="button" className={shared.iconBtn} aria-label={playing ? translate('imagine.pause') : translate('imagine.play')} onClick={transport.toggle}>
              <IconPlayOutlineRegular size={16} />
            </button>
            <span>{formatClock(currentTime)}</span>
            <input
              className={css.viewerSeek}
              type="range"
              min={0}
              max={duration || 0}
              step={0.05}
              value={currentTime}
              aria-label={translate('imagine.play')}
              onChange={(event) => { transport.seek(Number(event.currentTarget.value)) }}
            />
            <span>{formatClock(duration)}</span>
            <QualityBadge item={current} />
          </div>
        )}
        {current.kind !== 'audio' && !cropOn && (
          <div className={css.viewerPrompt}>
            <ViewerPrompt
              item={current}
              busy={busy}
              onEdit={image ? editPhoto : undefined}
              placeholder={preciseOn
                ? translate(painter.painted ? 'imagine.preciseDescribe' : 'imagine.precisePaint')
                : drawOn ? translate(sketch.count > 0 ? 'imagine.drawDescribe' : 'imagine.drawHint') : undefined}
              onRerun={onRerun}
              onAsk={onAsk}
            />
          </div>
        )}
      </div>
      {!folded && (
        <PostPanel
          item={current}
          tool={image ? tool : undefined}
          onTool={(next) => { setTool(next); setZoom(1); setPan({ x: 0, y: 0 }) }}
          actions={actions}
          liked={liked}
          onAction={(kind, anchor) => { onAction(kind, current, anchor) }}
        >
          {image && tool === 'segments' && (
            <SegmentsPanel
              status={segments.status}
              error={segments.error}
              onRetry={segments.retry}
              selected={picked}
              hover={hover}
              reveal={reveal}
              onHover={setHover}
              onGroupHover={setGroupHover}
              onPick={pickPart}
              onPickGroup={(ids) => { setJoinError(undefined); setPrompt(''); setPicked(ids.every(id => picked.includes(id)) ? [] : ids) }}
              onRemove={removePart}
            />
          )}
          {image && tool === 'precise' && (
            <PreciseTool brush={brush} onBrush={setBrush} painted={painter.painted} onClear={painter.clear} />
          )}
          {image && tool === 'colors' && (
            <ColorsTool
              colors={colors}
              onColors={setColors}
              onExtract={() => { setColors(photoColors(imageRef.current)) }}
              onApply={() => { if (colors.length > 0) onEdit(current, palettePrompt(colors)) }}
              busy={busy}
            />
          )}
          {image && tool === 'draw' && (
            <DrawTool
              brush={drawBrush}
              onBrush={setDrawBrush}
              erase={drawErase}
              onErase={setDrawErase}
              color={drawColor}
              onColor={setDrawColor}
              style={drawStyle}
              onStyle={setDrawStyle}
              inked={sketch.count > 0}
              busy={busy || sketching}
              onGenerate={() => { void sendSketch('') }}
            />
          )}
        </PostPanel>
      )}
      {segmentsOn && index !== undefined && hover !== undefined && cursor !== undefined && (
        <SegmentLabel label={index.segments.find(segment => segment.index === hover)?.label ?? ''} x={cursor.x} y={cursor.y} />
      )}
      {segmentsOn && index !== undefined && drawn !== undefined && pickedParts.length > 0 && zoom === 1 && pan.x === 0 && pan.y === 0 && (
        <SegmentEditBox
          picked={pickedParts}
          place={editBoxPlace(index, pickedParts, drawn)}
          prompt={prompt}
          onPrompt={setPrompt}
          busy={joining}
          error={joinError}
          onApply={(text, draft, reference) => { void applyParts(text, draft, reference) }}
          onLetGo={letGo}
        />
      )}
      {segmentsOn && drawn !== undefined && pickedParts.length === 1 && (
        <SegmentHint drawn={drawn} text={translate('imagine.segmentShiftHint')} />
      )}
    </div>
  )
}
