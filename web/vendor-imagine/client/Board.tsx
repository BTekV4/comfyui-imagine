/**
 * The project canvas: the dotted board with its tiles, notes and selection,
 * and everything that moves it — the camera, the zoom, dragging, resizing,
 * the marquee and the wheel.
 *
 * Split out of ImaginePage.tsx (2026-10-21). The camera and the zoom used to
 * be state of the whole page, so every pan frame, wheel notch and drag step
 * drew the rail, the chat column and the composer again. They live in a
 * small store the page owns (`createCanvasSession`) and only the board and
 * the zoom pill subscribe to it; the page reaches the board through its
 * handle (`BoardHandle`) and reads nothing of it while it moves.
 *
 * The moving parts are hooks of their own (2026-11-07): `use-board-camera`
 * (the session, the wheel, the pinch, the framing), `use-tile-drag` (moving
 * and resizing tiles) and `use-marquee` (the selection box).
 * @module Board
 */

import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react'
import type { CanvasNote, CanvasRect } from '../../../shared/imagine-projects.ts'
import type { GalleryItem, ImagineJobView as ImagineJob } from '../../../shared/imagine-types.ts'
import { canvasBounds, centreCamera, clampZoom, MAX_ZOOM, MIN_ZOOM, selectionBarAnchor, zoomAbout } from './canvas-layout.ts'
import { THUMB_TILE } from './gallery-api.ts'
import type { ImagineCanvasTool } from './gallery-store.ts'
import { CanvasNoteView, newNote } from './CanvasNotes.tsx'
import { CanvasToolbar } from './CanvasToolbar.tsx'
import { GenCard } from './GenCard.tsx'
import type { MediaActionKind } from './media-actions.tsx'
import { PendingTile, Tile, type TileCorner } from './Tile.tsx'
import { useBoardCamera, useCanvasView, type CanvasSession } from './use-board-camera.ts'
import { useMarquee } from './use-marquee.ts'
import { useTileDrag, type PressEvent } from './use-tile-drag.ts'
import shared from './imagine-shared.module.css'
import css from './Board.module.css'
import { translate } from './locale-store.ts'

export { createCanvasSession, type CanvasSession } from './use-board-camera.ts'

/** What the page asks of the board without re-rendering with it. */
export interface BoardHandle {
  /**
   * Take the canvas to one file and select it: centred in the board, zoomed
   * as Grok's "Show on canvas" does, picked as a click on it would.
   * @returns false when no tile for it is on this board.
   */
  focus(name: string): boolean
  /** Grok's "Generate image/video" card, with the selected photos as references. */
  openGenCard(mode: 'image' | 'video'): void
  /** Escape: close the canvas's own transient things; true when it did. */
  escape(): boolean
  /** Delete: drop the selected note; true when there was one to drop. */
  deleteSelectedNote(): boolean
  /** Every tile on screen at once ("Fit to view"). */
  fit(): void
  /** Zoom in or out about the middle of the board. */
  nudgeZoom(factor: number): void
}

interface BoardProps {
  readonly session: CanvasSession
  /** The open project, or undefined; the board frames once per project. */
  readonly projectId: string | undefined
  /** False on the History: no notes and no generation cards there. */
  readonly ownBoard: boolean
  readonly rects: readonly CanvasRect[]
  readonly itemsByName: ReadonlyMap<string, GalleryItem>
  readonly liveById: ReadonlyMap<string, ImagineJob>
  /** The files on the board, newest first, for bringing a new one into view. */
  readonly visibleNames: readonly string[]
  readonly picked: readonly string[]
  readonly busy: string | undefined
  /** The viewer is open over the board: tiles keep quiet. */
  readonly suspended: boolean
  readonly upscaling: Readonly<Record<string, ImagineJob>>
  readonly canvasTool: ImagineCanvasTool
  /** The floating chat column's width, kept clear when framing. */
  readonly chatWidth: number
  readonly status: 'idle' | 'loading' | 'error'
  readonly dropping: boolean
  readonly notes: readonly CanvasNote[] | undefined
  /** The selection bar's buttons; the board places the bar under the picked tiles. */
  readonly selectionTools: ReactNode
  /** The History's "show more", when there is more. */
  readonly more: { readonly count: number; readonly total: number } | undefined
  readonly onMore: () => void
  /** A tile pressed: the selection it leaves, and whether it adds to the last. */
  readonly onPress: (id: string, picked: readonly string[], additive: boolean) => void
  /** One tile alone selected and staged, without changing the composer's mode. */
  readonly onSelectOne: (id: string) => void
  /** The selection set from the board (marquee, notes). */
  readonly onPicked: (picked: readonly string[]) => void
  /** A marquee let go: what it picked is staged. */
  readonly onMarqueeEnd: (picked: readonly string[]) => void
  /** A plain press on the empty board: nothing picked, nothing staged. */
  readonly onClearPick: () => void
  readonly onPlace: (rects: readonly CanvasRect[]) => void
  readonly onNotesChange: (notes: readonly CanvasNote[]) => void
  readonly onGenerate: (mode: 'image' | 'video', refs: readonly GalleryItem[], text: string) => void
  readonly onTileAction: (kind: MediaActionKind, item: GalleryItem, anchor?: DOMRect) => void
  readonly onTileAsk: (item: GalleryItem, text: string) => void
  readonly onTileMenu: (item: GalleryItem, event: ReactMouseEvent<HTMLElement>) => void
  readonly onJobStop: (id: string) => void
}

export const Board = memo(forwardRef<BoardHandle, BoardProps>(function Board(props, ref) {
  const {
    session, projectId, ownBoard, rects, itemsByName, liveById, visibleNames, picked, busy, suspended, upscaling,
    canvasTool, chatWidth, status, dropping, notes, selectionTools, more, onMore, onTileAction, onTileAsk, onTileMenu,
    onJobStop,
  } = props
  /** The props as of the last render, for listeners registered once. */
  const latest = useRef(props)
  latest.current = props
  const boardRef = useRef<HTMLDivElement>(null)
  const {
    camera, zoom, textArmed, spaceRef, spacePan, panning, setZoom, setTextArmed, reveal, offScreen,
    inView, boardView, pointOf, viewCentre, startPan, movePan, endPan,
  } = useBoardCamera({ session, boardRef, projectId, rects, liveById, chatWidth })
  /*
   * The tool a press on the EMPTY board acts with, read from the press itself
   * (never from keydown/keyup, which a lost keyup used to leave swapped).
   * Tiles never ask: on Grok they are picked and dragged with either tool.
   */
  const pressTool = (event: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number }): ImagineCanvasTool => {
    /*
     * As Grok Imagine's canvas (React Flow, read again 2026-11-15): the
     * middle button and space+drag pan with either tool, shift draws the
     * marquee with either — panOnDrag [1] with the arrow, [0, 1] with the
     * hand, panActivationKeyCode Space, selectionKeyCode Shift. Ctrl does
     * nothing of its own there.
     */
    if (event.button === 1 || spaceRef.current) return 'hand'
    if (canvasTool === 'hand') return event.shiftKey === true ? 'select' : 'hand'
    return 'select'
  }

  const tiles = useTileDrag({
    rects, itemsByName, picked, zoom, spaceRef, pointOf, pressTool,
    onPress: props.onPress, onSelectOne: props.onSelectOne, onPlace: props.onPlace,
  })
  const { drag, guides, liveRects, startResize, pressTile } = tiles
  const marquee = useMarquee({
    rects, picked, onPicked: props.onPicked, onMarqueeEnd: props.onMarqueeEnd, onClearPick: props.onClearPick,
  })
  /** A "Generate image/video" card on the board, in world units. */
  const [genCard, setGenCard] = useState<{ x: number; y: number; mode: 'image' | 'video'; refs: readonly GalleryItem[] } | undefined>(undefined)
  /** The canvas note selected (its frame and bar showing), and the one being written. */
  const [selectedNote, setSelectedNote] = useState<string | undefined>(undefined)
  const [editingNote, setEditingNote] = useState<string | undefined>(undefined)

  /** What arrived out of view, counted instead of followed: the pill's state. */
  const [newMedia, setNewMedia] = useState<{ count: number; name: string } | undefined>(undefined)

  /**
   * The newest of some tiles, by when each one was made: the pill travels to
   * the last thing that arrived, not to whichever the list happened to name
   * first.
   * @param ids - the ids to choose among.
   * @param at - when one was made, epoch milliseconds.
   * @returns the newest id, or undefined for an empty list.
   */
  const newestOf = (ids: readonly string[], at: (id: string) => number): string | undefined => {
    let best: string | undefined
    let bestAt = Number.NEGATIVE_INFINITY
    for (const id of ids) {
      const when = at(id)
      if (when > bestAt) {
        best = id
        bestAt = when
      }
    }
    return best
  }

  // The count belongs to the board it was counted on: a project switch starts
  // from that project's own place, not from the last one's leftovers.
  useEffect(() => { setNewMedia(undefined) }, [projectId])

  /**
   * Take the board to the newest piece it counted — on a press, never by
   * itself: the camera is the user's place on the board.
   */
  const showNew = (): void => {
    const target = newMedia?.name
    setNewMedia(undefined)
    if (target !== undefined) reveal(target)
  }

  /*
   * A generation that just started, and a file that just landed, are COUNTED,
   * not followed.
   *
   * Both used to bring the new tile into view, which meant a run landing at
   * the bottom of a long board pulled the canvas away from whatever the user
   * was reading — once when it started, again when it finished, and again for
   * every file another device produced. Nobody asked to be moved. The pill
   * under the board carries the count and takes the camera there when, and
   * only when, it is pressed.
   *
   * Both are marked as seen as soon as they are counted, so a job or a file
   * is never counted twice.
   */
  const liveKey = [...liveById.keys()].join('\n')
  useEffect(() => {
    const fresh = [...latest.current.liveById.keys()].filter(id => !session.shownLive.has(id))
    if (fresh.length === 0) return
    for (const id of fresh) session.shownLive.add(id)
    const newest = newestOf(fresh, id => latest.current.liveById.get(id)?.createdAt ?? 0)
    if (newest === undefined || !offScreen(newest)) return
    setNewMedia(held => ({ count: (held?.count ?? 0) + fresh.length, name: newest }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the live ids and the layout
  }, [liveKey, rects])

  /*
   * A file that just landed, the same way. A shot the host queued and adopted
   * on its own — a redo asked for from another device — has no placeholder
   * here to be revealed while it runs, so the finished file is the first this
   * board sees of it. Seeded once the opening framing has happened, so what
   * the project already held is not counted tile by tile as the gallery
   * arrives.
   */
  useEffect(() => {
    if (projectId === undefined) return
    const shown = session.shownFiles
    if (shown.projectId !== projectId || !shown.framed) {
      session.shownFiles = { projectId, framed: session.framed === projectId, names: new Set(visibleNames) }
      return
    }
    const fresh = visibleNames.filter(name => !shown.names.has(name))
    if (fresh.length === 0) return
    for (const name of fresh) shown.names.add(name)
    const newest = newestOf(fresh, name => itemsByName.get(name)?.mtime ?? 0)
    if (newest === undefined || !offScreen(newest)) return
    setNewMedia(held => ({ count: (held?.count ?? 0) + fresh.length, name: newest }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reveal reads the session
  }, [projectId, visibleNames, rects, session])

  const pickedSet = useMemo(() => new Set(picked), [picked])

  /**
   * Where a multi-selection's own bar sits: centred under the picked tiles.
   *
   * Read off `liveRects`, so it follows a drag in progress rather than
   * snapping to where the tiles were before it.
   */
  const selectionBar = useMemo(
    () => selectionBarAnchor(liveRects.filter(rect => pickedSet.has(rect.id)), zoom),
    [pickedSet, liveRects, zoom],
  )

  /** A text box at a point of the board, ready to write in. */
  const addNoteAt = (x: number, y: number): void => {
    if (notes === undefined) return
    const note = newNote(x, y)
    props.onNotesChange([...notes, note])
    props.onPicked([])
    setSelectedNote(note.id)
    setEditingNote(note.id)
    setTextArmed(false)
  }

  const submitGenCard = (text: string): void => {
    const card = genCard
    if (card === undefined) return
    setGenCard(undefined)
    props.onGenerate(card.mode, card.refs, text)
  }

  useImperativeHandle(ref, () => ({
    focus: (name) => {
      const rect = liveRects.find(entry => entry.id === name)
      const board = boardRef.current
      if (rect === undefined || board === null) return false
      const box = boardView(board)
      // Zoomed onto it, as Grok's "Show on canvas" does: the tile takes about
      // two thirds of the board's height (or half its width, if wider).
      const next = clampZoom(Math.min(box.height * 0.66 / rect.h, box.width * 0.5 / rect.w))
      session.set({ zoom: next, camera: centreCamera(box, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, next) })
      latest.current.onSelectOne(name)
      return true
    },
    openGenCard: (mode) => {
      const centre = viewCentre()
      if (centre === undefined || !ownBoard) return
      const refs = picked.map(id => itemsByName.get(id)).filter((entry): entry is GalleryItem => entry?.kind === 'image')
      // A free spot, as Grok's findOpenPosition: slid right past whatever tile
      // the middle of the view lands on.
      let x = centre.x - 130
      const y = centre.y - 260
      for (let guard = 0; guard < 50; guard += 1) {
        const hit = liveRects.find(rect => rect.x < x + 260 && rect.x + rect.w > x && rect.y < y + 462 && rect.y + rect.h > y)
        if (hit === undefined) break
        x = hit.x + hit.w + 24
      }
      setGenCard({ x, y, mode, refs })
      setTextArmed(false)
    },
    escape: () => {
      if (genCard !== undefined) { setGenCard(undefined); return true }
      if (session.get().textArmed) { setTextArmed(false); return true }
      if (selectedNote !== undefined) { setSelectedNote(undefined); return true }
      return false
    },
    deleteSelectedNote: () => {
      if (selectedNote === undefined || editingNote !== undefined || notes === undefined) return false
      setSelectedNote(undefined)
      props.onNotesChange(notes.filter(entry => entry.id !== selectedNote))
      return true
    },
    fit: () => {
      const board = boardRef.current
      if (board === null || liveRects.length === 0) return
      const box = boardView(board)
      const { minX: left, minY: top, maxX: right, maxY: bottom } = canvasBounds(liveRects)
      const pad = 48
      const next = clampZoom(Math.min((box.width - pad * 2) / Math.max(1, right - left), (box.height - pad * 2) / Math.max(1, bottom - top), 1))
      session.set({ zoom: next, camera: centreCamera(box, { x: (left + right) / 2, y: (top + bottom) / 2 }, next) })
    },
    nudgeZoom: (factor) => {
      const next = clampZoom(zoom * factor)
      if (next === zoom) return
      const board = boardRef.current
      if (board === null) {
        setZoom(next)
        return
      }
      const box = board.getBoundingClientRect()
      session.set({ zoom: next, camera: zoomAbout(camera, zoom, next, box.width / 2, box.height / 2) })
    },
  }))

  const onBoardMove = (event: { clientX: number; clientY: number }): void => {
    if (movePan(event)) return
    const point = pointOf(event)
    if (point === undefined) return
    if (tiles.moveResize(point)) return
    if (marquee.move(point)) return
    tiles.moveDrag(point)
  }

  const endDrag = (): void => {
    tiles.clearGuides()
    if (tiles.endResize()) return
    if (endPan()) return
    if (marquee.end()) return
    tiles.endDrag()
  }

  const startMarquee = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.closest('[data-imagine-tools]')) return
    const tool = pressTool(event)
    // A tile takes its own press with either tool, as Grok's nodes stay
    // draggable under the hand (2026-11-15); only the middle button and
    // space+drag pan from on top of one.
    if (target.closest('[data-imagine-card], [data-imagine-job]') && event.button !== 1 && !spaceRef.current) return
    // A right press is the context menu's, never a pan or a marquee.
    if (event.button === 2) return
    if (selectedNote !== undefined && !target.closest('[data-imagine-note]')) setSelectedNote(undefined)
    if (textArmed && event.button === 0 && tool !== 'hand' && !target.closest('[data-imagine-card], [data-imagine-job]')) {
      const point = pointOf(event)
      if (point !== undefined) {
        event.preventDefault()
        addNoteAt(point.x, point.y - 12)
      }
      return
    }
    if (tool === 'hand') {
      event.preventDefault()
      startPan(event)
      return
    }
    const point = pointOf(event)
    if (point === undefined) return
    event.preventDefault()
    marquee.begin(point, event.shiftKey || event.metaKey)
  }

  /*
   * The tiles get handlers that never change identity, so a memoized tile
   * re-renders only when its own props do. Each reads the render's functions
   * through a ref, so they still see the current state.
   */
  const tileRef = useRef({ pressTile, startResize })
  tileRef.current = { pressTile, startResize }
  const onTilePress = useCallback((id: string, event: PressEvent) => { tileRef.current.pressTile(id, event) }, [])
  const onTileResize = useCallback((id: string, corner: TileCorner, event: ReactPointerEvent<HTMLElement>) => {
    tileRef.current.startResize(id, corner, event)
  }, [])

  const empty = rects.length === 0
  const singlePick = picked.length === 1 ? picked[0] : undefined
  const pixelRatio = globalThis.devicePixelRatio || 1

  return (
    <div
      ref={boardRef}
      className={`${css.board}${canvasTool === 'hand' || spacePan ? ` ${css.boardHand}` : ''}${panning ? ` ${css.boardPanning}` : ''}`}
      style={textArmed ? { cursor: 'text' } : undefined}
      onPointerDown={startMarquee}
      // The middle button pans here; the browser's autoscroll would
      // take it first.
      onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
      onDoubleClick={(event) => {
        // On the empty board, as Grok's zoomOnDoubleClick: twice
        // as close at the pointer, shift to go back out.
        if (!(event.target instanceof HTMLElement) || event.target.closest('[data-imagine-card], [data-imagine-job], [data-imagine-note], [data-imagine-tools]')) return
        const box = event.currentTarget.getBoundingClientRect()
        const next = clampZoom(zoom * (event.shiftKey ? 0.5 : 2))
        session.set({ zoom: next, camera: zoomAbout(camera, zoom, next, event.clientX - box.left, event.clientY - box.top) })
      }}
      onPointerMove={onBoardMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
    >
      <div
        className={css.grid}
        aria-hidden="true"
        style={{
          /*
           * Zoomed out, the 22px world step would put dots 2px apart —
           * a grey haze at 10%. Every other dot drops out instead, so
           * the screen step stays at least 11px, and a dot never shrinks
           * below half its size.
           */
          '--imagine-grid-step': `${String(22 * zoom * 2 ** Math.max(0, Math.ceil(Math.log2(0.5 / zoom))))}px`,
          '--imagine-grid-dot': String(Math.max(zoom, 0.5)),
          '--imagine-grid-x': `${String(camera.x)}px`,
          '--imagine-grid-y': `${String(camera.y)}px`,
        } as CSSProperties}
      />
      {status === 'loading' && empty && <p className={shared.note}>{translate('imagine.loading')}</p>}
      {status === 'error' && <p className={shared.error} role="alert">{translate('imagine.error')}</p>}
      {status !== 'loading' && empty && (
        <p className={shared.note}>{dropping ? translate('imagine.dropHere') : translate('imagine.emptyProject')}</p>
      )}
      <div
        className={css.canvas}
        style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${zoom})` }}
      >
        {genCard !== undefined && (
          <GenCard
            x={genCard.x}
            y={genCard.y}
            mode={genCard.mode}
            refs={genCard.refs}
            zoom={zoom}
            onSubmit={submitGenCard}
            onClose={() => { setGenCard(undefined) }}
          />
        )}
        {guides.x !== undefined && (
          <div className={css.guideV} style={{ left: guides.x, width: 1 / zoom }} aria-hidden="true" />
        )}
        {guides.y !== undefined && (
          <div className={css.guideH} style={{ top: guides.y, height: 1 / zoom }} aria-hidden="true" />
        )}
        {marquee.box !== undefined && marquee.box.w + marquee.box.h > 0 && (
          <div
            className={css.marquee}
            style={{
              left: marquee.box.x,
              top: marquee.box.y,
              width: marquee.box.w,
              height: marquee.box.h,
            }}
          />
        )}
        {liveRects.map((rect) => {
          const job = liveById.get(rect.id)
          const isPicked = pickedSet.has(rect.id)
          const isDragged = drag !== undefined && drag.active && drag.ids.includes(rect.id)
          // Off screen and not in hand: not drawn. A picked or
          // dragged tile stays, so its bar and its drag survive.
          if (!isPicked && !isDragged && !inView(rect)) return null
          if (job !== undefined) {
            return (
              <PendingTile
                key={rect.id}
                rect={rect}
                job={job}
                picked={isPicked}
                dragging={isDragged}
                onPress={onTilePress}
                onStop={onJobStop}
              />
            )
          }
          const item = itemsByName.get(rect.id)
          if (item === undefined) return null
          const showTools = singlePick === item.name
          /*
           * The zoom reaches only the tile with its tools up, which
           * counter-scales them; every other tile gets the one fact it
           * needs — whether it is drawn wider than its 640px cut — so a zoom
           * does not re-render the whole board's tiles.
           */
          const sharp = rect.w * zoom * pixelRatio > THUMB_TILE
          return (
            <Tile
              key={rect.id}
              rect={rect}
              item={item}
              zoom={showTools ? zoom : undefined}
              sharp={sharp}
              busy={busy === item.name}
              picked={isPicked}
              dragging={isDragged}
              showTools={showTools}
              upscaling={upscaling[item.name]}
              // The viewer plays the file on its own: a tile still
              // playing underneath it was the same clip heard twice.
              suspended={suspended}
              onPress={onTilePress}
              onAction={onTileAction}
              onAsk={onTileAsk}
              onMenu={onTileMenu}
              onResize={onTileResize}
            />
          )
        })}
        {notes !== undefined && notes.map(note => (
          <CanvasNoteView
            key={note.id}
            note={note}
            zoom={zoom}
            editing={editingNote === note.id}
            selected={selectedNote === note.id}
            onSelect={() => { setSelectedNote(note.id); props.onPicked([]) }}
            onEdit={(on) => { setEditingNote(on ? note.id : undefined); if (on) setSelectedNote(note.id) }}
            onChange={(next) => { props.onNotesChange(notes.map(entry => (entry.id === next.id ? next : entry))) }}
            onDelete={() => {
              setEditingNote(undefined)
              setSelectedNote(undefined)
              props.onNotesChange(notes.filter(entry => entry.id !== note.id))
            }}
          />
        ))}
        {/*
          * Under the selection itself, the way one tile's tools sit
          * under that tile: the action belongs to the thing selected,
          * not to a corner of the screen. It rides inside the canvas
          * layer so it pans with the board, and counter-scales so it
          * stays the same size at any zoom.
          */}
        {selectionBar !== undefined && (
          <div
            className={css.selectionBar}
            data-imagine-tools
            style={{
              left: selectionBar.x,
              top: selectionBar.y,
              transform: `translateX(-50%) scale(${1 / zoom})`,
            }}
          >
            {selectionTools}
          </div>
        )}
      </div>
      {newMedia !== undefined && (
        <button
          type="button"
          className={css.newMedia}
          data-imagine-new={newMedia.count}
          onClick={showNew}
        >
          {newMedia.count === 1
            ? translate('imagine.newMediaOne')
            : translate('imagine.newMediaMany', { count: String(newMedia.count) })}
        </button>
      )}
      {more !== undefined && (
        <button
          type="button"
          className={shared.historyMore}
          data-imagine-tools
          onClick={onMore}
        >
          {translate('imagine.historyMore', { count: String(more.count), total: String(more.total) })}
        </button>
      )}
    </div>
  )
}))

/**
 * The canvas bar under the board, reading the board's view on its own: the
 * zoom pill follows the wheel without the page drawing again.
 */
export function BoardToolbar({ session, board, tool, ownBoard, onTool, onUpload, onRegrid }: {
  readonly session: CanvasSession
  readonly board: { readonly current: BoardHandle | null }
  readonly tool: ImagineCanvasTool
  readonly ownBoard: boolean
  readonly onTool: (tool: ImagineCanvasTool) => void
  readonly onUpload: (files: FileList | readonly File[]) => void
  readonly onRegrid: () => void
}) {
  const zoom = useCanvasView(session, state => state.zoom)
  const textArmed = useCanvasView(session, state => state.textArmed)
  return (
    <CanvasToolbar
      tool={tool}
      onTool={(next) => { session.set({ textArmed: false }); onTool(next) }}
      zoom={zoom}
      canZoomIn={zoom < MAX_ZOOM}
      canZoomOut={zoom > MIN_ZOOM}
      onZoomIn={() => { board.current?.nudgeZoom(1.25) }}
      onZoomOut={() => { board.current?.nudgeZoom(1 / 1.25) }}
      onFit={() => { board.current?.fit() }}
      onGenerateImage={() => { board.current?.openGenCard('image') }}
      onGenerateVideo={() => { board.current?.openGenCard('video') }}
      textArmed={textArmed}
      onText={() => { session.set({ textArmed: !session.get().textArmed }) }}
      onUpload={onUpload}
      onRegrid={onRegrid}
      ownBoard={ownBoard}
    />
  )
}
