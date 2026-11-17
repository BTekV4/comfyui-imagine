/**
 * The board's camera: where it sits and how far in, kept in a small store the
 * page owns (`createCanvasSession`) so a pan frame draws the board and not
 * the page; the wheel, the pinch, space to pan, the opening framing, and the
 * conversions between the screen and the board's world. Split out of
 * Board.tsx (2026-11-07).
 * @module use-board-camera
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import type { CanvasRect } from '../../../shared/imagine-projects.ts'
import type { ImagineJobView as ImagineJob } from '../../../shared/imagine-types.ts'
import {
  BOARD_COLUMN, clampZoom, isMouseWheel, openingCamera, revealCamera, wheelPixels, zoomAbout,
} from './canvas-layout.ts'
import { isTypingTarget } from './typing.ts'
import { createSignal, useSelected } from './signal.ts'
import { STACKED_QUERY, useMediaQuery } from './use-media-query.ts'

/** What the board's view is: where the camera sits, how far in, and the text tool. */
interface CanvasViewState {
  readonly camera: { readonly x: number; readonly y: number }
  readonly zoom: number
  /** "Text" armed: the next press on the empty board places a text box. */
  readonly textArmed: boolean
}

/**
 * The board's view, kept by the page across the board's own mounts.
 *
 * Besides the subscribable view it carries what must outlive one mount of the
 * board — which project was framed, which jobs and files were already brought
 * into view — so switching the History from list to board, or opening the
 * files pane, does not frame or reveal again.
 */
export interface CanvasSession {
  get(): CanvasViewState
  set(next: Partial<CanvasViewState>): void
  subscribe(listener: () => void): () => void
  /** The project the camera has been framed on, so framing happens once each. */
  framed: string | undefined
  /** Live jobs already brought into view. */
  readonly shownLive: Set<string>
  /** Files already on the board when it was framed, or brought into view since. */
  shownFiles: { projectId?: string; framed: boolean; names: Set<string> }
}

/**
 * A fresh board view: origin, 100%, no tool armed.
 * @returns the session the page keeps for the life of the studio.
 */
export function createCanvasSession(): CanvasSession {
  const signal = createSignal<CanvasViewState>({ camera: { x: 0, y: 0 }, zoom: 1, textArmed: false })
  return {
    get: signal.get,
    // The zoom is clamped on the way in, and a change to nothing is no change.
    set: (next) => {
      const state = signal.get()
      const zoom = next.zoom === undefined ? state.zoom : clampZoom(next.zoom)
      const camera = next.camera ?? state.camera
      const textArmed = next.textArmed ?? state.textArmed
      if (zoom === state.zoom && camera === state.camera && textArmed === state.textArmed) return
      signal.set({ camera, zoom, textArmed })
    },
    subscribe: signal.subscribe,
    framed: undefined,
    shownLive: new Set(),
    shownFiles: { framed: false, names: new Set() },
  }
}

/**
 * One value of the board's view, re-rendering only when it changes.
 * @param session - the page's board session.
 * @param select - which part of the view to read.
 * @returns the selected value.
 */
export function useCanvasView<T>(session: CanvasSession, select: (state: CanvasViewState) => T): T {
  return useSelected(session, select)
}

/** What the camera reads of the board. */
export interface BoardCameraContext {
  readonly session: CanvasSession
  /** The board's root, measured and listened on. */
  readonly boardRef: RefObject<HTMLDivElement | null>
  /** The open project, or undefined; the board frames once per project. */
  readonly projectId: string | undefined
  readonly rects: readonly CanvasRect[]
  readonly liveById: ReadonlyMap<string, ImagineJob>
  /** The floating chat column's width, kept clear when framing. */
  readonly chatWidth: number
}

export function useBoardCamera({ session, boardRef, projectId, rects, liveById, chatWidth }: BoardCameraContext) {
  const camera = useCanvasView(session, state => state.camera)
  const zoom = useCanvasView(session, state => state.zoom)
  const textArmed = useCanvasView(session, state => state.textArmed)
  /*
   * Whether the chat floats over the board's left edge rather than sitting
   * above it: on a phone the column stacks above the canvas, and costs it no
   * width to keep clear of.
   */
  const wide = !useMediaQuery(STACKED_QUERY)
  /** The board's size on screen, for drawing only the tiles in view. */
  const [boardSize, setBoardSize] = useState({ width: 0, height: 0 })
  const [pan, setPan] = useState<{
    originX: number
    originY: number
    cameraX: number
    cameraY: number
  } | undefined>(undefined)
  /** Space held down over the canvas: a drag pans, whatever the tool. */
  const spaceRef = useRef(false)
  const [spacePan, setSpacePan] = useState(false)
  /** The zoom a Safari pinch started from: `event.scale` counts from there. */
  const pinchRef = useRef(1)

  const setZoom = (next: number): void => { session.set({ zoom: next }) }
  const setCamera = (next: { x: number; y: number }): void => { session.set({ camera: next }) }
  const setTextArmed = (armed: boolean): void => { session.set({ textArmed: armed }) }

  /*
   * The board is this component's root, so the listeners below are attached
   * whenever it is mounted. They used to live in the page keyed on the view
   * alone: a project opened from the History's list had a board with no wheel
   * and no pinch, and ctrl+wheel zoomed the browser instead.
   */
  useEffect(() => {
    const node = boardRef.current
    if (node === null) return
    const measure = (): void => {
      setBoardSize(previous => (previous.width === node.clientWidth && previous.height === node.clientHeight
        ? previous
        : { width: node.clientWidth, height: node.clientHeight }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    const node = boardRef.current
    if (node === null) return
    const onWheel = (event: WheelEvent): void => {
      // A scrollable panel over the board (a note being written, a menu)
      // keeps its own wheel.
      if (event.target instanceof Element && event.target.closest('[data-imagine-nowheel]')) return
      event.preventDefault()
      const box = node.getBoundingClientRect()
      /*
       * Grok Imagine's canvas, read from its code (useSmartWheel, 2026-10-17):
       * a mouse notch zooms at the pointer, two fingers on a touchpad pan,
       * a pinch zooms. The device is told apart on each event by the only
       * signals that identify it — a delta in lines or pages, or a
       * wheelDeltaY that is a whole multiple of 120 — so there is nothing to
       * choose and nothing to remember.
       *
       * Zoom and camera are read from the session and written back at once:
       * several wheel events land in one frame, and each must start from the
       * last one's result, not from the last render.
       */
      const { zoom: from, camera: at } = session.get()
      const zoomAt = (next: number): void => {
        const clamped = clampZoom(next)
        if (clamped === from) return
        session.set({ zoom: clamped, camera: zoomAbout(at, from, clamped, event.clientX - box.left, event.clientY - box.top) })
      }
      if (event.ctrlKey) {
        // A pinch (and ctrl+wheel). React Flow's step: macOS sends small
        // deltas for a pinch and is scaled up tenfold there.
        const mac = /Mac|iPhone|iPad/.test(navigator.platform)
        const step = event.deltaMode === 1 ? 0.05 : event.deltaMode !== 0 ? 1 : 0.002
        zoomAt(from * 2 ** (-event.deltaY * step * (mac ? 10 : 1)))
        return
      }
      if (isMouseWheel(event)) {
        zoomAt(from * 2 ** (-(event.deltaMode === 1 ? 16 * event.deltaY : event.deltaY) / 300))
        return
      }
      session.set({ camera: { x: at.x - wheelPixels(event.deltaX, event.deltaMode), y: at.y - wheelPixels(event.deltaY, event.deltaMode) } })
    }
    const onGesture = (event: Event): void => {
      event.preventDefault()
      // Safari's `event.scale` counts from the start of the pinch, not from the
      // last event, so it multiplies the zoom the gesture BEGAN at.
      if (event.type === 'gesturestart') { pinchRef.current = session.get().zoom; return }
      const scale = 'scale' in event && typeof event.scale === 'number' ? event.scale : 1
      if (event.type === 'gesturechange') session.set({ zoom: pinchRef.current * scale })
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    node.addEventListener('gesturestart', onGesture)
    node.addEventListener('gesturechange', onGesture)
    return () => {
      node.removeEventListener('wheel', onWheel)
      node.removeEventListener('gesturestart', onGesture)
      node.removeEventListener('gesturechange', onGesture)
    }
  }, [session])

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) return
      // The page would scroll, and a button with focus would be pressed.
      event.preventDefault()
      if (!spaceRef.current) { spaceRef.current = true; setSpacePan(true) }
    }
    const up = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return
      spaceRef.current = false
      setSpacePan(false)
    }
    // A keyup lost to another window would leave space "held" for good.
    const reset = (): void => { spaceRef.current = false; setSpacePan(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', reset)
    }
  }, [])

  /*
   * Frame the board on the tiles, once per project. The camera opens shifted
   * right of the floating chat so the first tiles are not born under it, and
   * shifted onto the arrangement so a board saved on a wider screen is not
   * left entirely below the fold — which is what a phone showed: twenty-four
   * tiles in the DOM, none of them on screen, and an empty-looking canvas that
   * said nothing because the tiles did exist.
   *
   * It waits for a layout rather than running with the project id: the gallery
   * arrives a moment later, and framing an empty list would pin the camera at
   * the origin for good. The session keeps it to one framing per project, so
   * a tile landing later never yanks the board out from under the user.
   */
  useEffect(() => {
    if (projectId === undefined || rects.length === 0 || session.framed === projectId) return
    session.framed = projectId
    // The runs already going when the board opens are not "new": they were
    // there before the user looked, and the pill counts only what starts or
    // lands afterwards.
    for (const id of liveById.keys()) session.shownLive.add(id)
    const opening = openingCamera(rects, wide ? chatWidth + 24 : 0)
    // The board no longer narrows its columns for a phone: it opens zoomed
    // out instead, two columns across, the way it used to read there.
    const boardWidth = boardRef.current?.clientWidth ?? 0
    if (!wide && boardWidth > 0 && boardWidth < 2 * BOARD_COLUMN + 60) {
      const fit = clampZoom((boardWidth - 24) / (2 * BOARD_COLUMN + 12))
      session.set({ zoom: fit, camera: { x: 12 + opening.x * fit, y: opening.y * fit } })
      return
    }
    setCamera(opening)
  }, [projectId, rects, chatWidth, session])

  /**
   * Bring one tile into view when it is off screen. The board is laid out in
   * generation order, so a new tile lands at the bottom — on a board of fifty
   * tiles three screens down — and was reported as gone.
   * @param id - the tile to show.
   */
  const reveal = (id: string): void => {
    const rect = rects.find(entry => entry.id === id)
    const board = boardRef.current
    if (rect === undefined || board === null) return
    const { camera: at, zoom: scale } = session.get()
    const next = revealCamera(rect, at, scale, { width: board.clientWidth, height: board.clientHeight },
      wide ? chatWidth + 24 : 24)
    if (next !== undefined) setCamera(next)
  }

  /**
   * Whether a tile is off screen right now, so the "new" pill has something to
   * offer: a tile already in view needs neither a trip nor a button.
   * @param id - the tile's id: a job id, or a file name.
   */
  const offScreen = (id: string): boolean => {
    const rect = rects.find(entry => entry.id === id)
    const board = boardRef.current
    if (rect === undefined || board === null) return false
    const { camera: at, zoom: scale } = session.get()
    return revealCamera(rect, at, scale, { width: board.clientWidth, height: board.clientHeight },
      wide ? chatWidth + 24 : 24) !== undefined
  }

  /**
   * Whether a tile is on screen, with half a screen of margin each way. A
   * board of hundreds of files drew every one of them on every pan frame;
   * before the board is measured everything counts as in view.
   * @param rect - the tile, in world units.
   */
  const inView = (rect: CanvasRect): boolean => {
    if (boardSize.width === 0 || boardSize.height === 0) return true
    const marginX = boardSize.width / zoom / 2
    const marginY = boardSize.height / zoom / 2
    const left = -camera.x / zoom - marginX
    const top = -camera.y / zoom - marginY
    const right = (boardSize.width - camera.x) / zoom + marginX
    const bottom = (boardSize.height - camera.y) / zoom + marginY
    return rect.x + rect.w >= left && rect.x <= right && rect.y + rect.h >= top && rect.y <= bottom
  }

  /**
   * The part of the board the user can see, in board coordinates: the chat
   * column floats over its left side, so centring on the whole board put the
   * tiles half under the conversation.
   */
  const boardView = (board: HTMLElement): { left: number; width: number; height: number } => {
    const box = board.getBoundingClientRect()
    // Found by its data attributes, not by class names of another module.
    const chat = board.closest('[data-imagine-studio]')?.querySelector('[data-imagine-chat]')
    const cover = chat instanceof HTMLElement && getComputedStyle(chat).position === 'absolute'
      ? Math.max(0, Math.min(box.width / 2, chat.getBoundingClientRect().right - box.left))
      : 0
    return { left: cover, width: box.width - cover, height: box.height }
  }

  const pointOf = (event: { clientX: number; clientY: number }): { x: number; y: number } | undefined => {
    const board = boardRef.current
    if (board === null) return undefined
    const box = board.getBoundingClientRect()
    return {
      x: (event.clientX - box.left - camera.x) / zoom,
      y: (event.clientY - box.top - camera.y) / zoom,
    }
  }

  /** The middle of what the user is looking at, in world units. */
  const viewCentre = (): { x: number; y: number } | undefined => {
    const board = boardRef.current
    if (board === null) return undefined
    const box = boardView(board)
    return { x: (box.left + box.width / 2 - camera.x) / zoom, y: (box.height / 2 - camera.y) / zoom }
  }

  /**
   * A pan of the camera from a press on the board.
   * @param event - the press.
   */
  const startPan = (event: { clientX: number; clientY: number }): void => {
    setPan({
      originX: event.clientX,
      originY: event.clientY,
      cameraX: camera.x,
      cameraY: camera.y,
    })
  }
  /** Follow a pan in progress; true when there was one. */
  const movePan = (event: { clientX: number; clientY: number }): boolean => {
    if (pan !== undefined) {
      setCamera({
        x: pan.cameraX + (event.clientX - pan.originX),
        y: pan.cameraY + (event.clientY - pan.originY),
      })
      return true
    }
    return false
  }
  /** End a pan in progress; true when there was one. */
  const endPan = (): boolean => {
    if (pan !== undefined) {
      setPan(undefined)
      return true
    }
    return false
  }

  return {
    camera, zoom, textArmed, wide, spaceRef, spacePan, panning: pan !== undefined,
    setZoom, setCamera, setTextArmed, reveal, offScreen, inView, boardView, pointOf, viewCentre,
    startPan, movePan, endPan,
  }
}
