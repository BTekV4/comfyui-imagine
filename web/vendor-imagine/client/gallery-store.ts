/**
 * Imagine studio store: home vs project, rail, canvas tool, and user-moved
 * tile positions, persisted per browser.
 * @module gallery-store
 */

import { createStore, type StoreInstance } from '../../shims/store/index.ts'
import { HISTORY_FILTERS_DEFAULT, type HistoryFilters } from './imagine-filters.ts'
import type { ImagineTombstones } from './imagine-projects.ts'
import type { CanvasRect, ImagineProject } from '../../../shared/imagine-projects.ts'

/*
 * Chat column bounds, as Grok Imagine's (`atlas-chat-width`, read 2026-11-15):
 * 360 to 560, 400 to start with. It went down to 200 from September (asked
 * then to leave the board more room), but squeezed that far the column looked
 * broken, and the user asked for Grok's floor (2026-11-15). On a narrow window
 * the page caps it lower (CHAT_NARROW_MAX). `min-width` on `.chatCol` mirrors
 * CHAT_MIN.
 */
/** Narrowest the project chat column is drawn. */
export const CHAT_MIN = 360
/** Widest the project chat column is drawn on a wide window. */
export const CHAT_MAX = 560
/** Width of the chat column before the user drags it. */
export const CHAT_DEFAULT = 400

/** The default before 2026-11-15: a width still at it was never chosen, and takes the new one. */
export const CHAT_OLD_DEFAULT = 360

/**
 * A chat column width within [CHAT_MIN, CHAT_MAX].
 * @param width - the width asked for, in CSS pixels.
 * @returns the rounded width in bounds; the default for a non-finite input.
 */
function clampChatWidth(width: number): number {
  if (!Number.isFinite(width)) return CHAT_DEFAULT
  return Math.min(CHAT_MAX, Math.max(CHAT_MIN, Math.round(width)))
}

/** Which Imagine stage is visible. */
export type ImagineView = 'home' | 'project' | 'projects' | 'social' | 'settings' | 'plugins' | 'library' | 'media'
  /** Openjutsu and IOPaint, shown inside the studio (AppFrame.tsx, 2026-11-09). */
  | 'openjutsu' | 'iopaint'

/** The stages reached from the rail, with no project open. */
export type ImagineStage = Exclude<ImagineView, 'project'>

/** How the project canvas interprets a pointer drag. */
export type ImagineCanvasTool = 'select' | 'hand'

/** Studio state. */
type GalleryState = {
  view: ImagineView
  projectId: string | undefined
  projects: readonly ImagineProject[]
  railCollapsed: boolean
  /** The expanded rail's dragged width; the collapsed strip ignores it. */
  chatWidth: number
  /**
   * Whether the project view hides its chat column and gives the board the
   * whole width. Persisted with the rest of the store, so it is per browser:
   * the laptop can work on the canvas while the desktop keeps the column.
   */
  chatHidden: boolean
  canvasTool: ImagineCanvasTool
  /**
   * How the History is filtered, ordered and drawn. Persisted with the rest of
   * the store, so it is per browser: filtering the history is a way of working
   * that outlives a reload.
   */
  historyFilters: HistoryFilters
  placed: Record<string, CanvasRect>
  /** Projects the user deleted, by id, with when. See ImagineTombstones. */
  deleted: Record<string, number>
}

/** Studio write set. */
type GalleryActions = {
  go: (draft: GalleryState, view: ImagineStage) => void
  openProject: (draft: GalleryState, id: string) => void
  setProjects: (draft: GalleryState, projects: readonly ImagineProject[]) => void
  upsertProject: (draft: GalleryState, project: ImagineProject) => void
  purgeProjects: (draft: GalleryState, ids: readonly string[], at: number) => void
  setDeleted: (draft: GalleryState, deleted: ImagineTombstones) => void
  setRailCollapsed: (draft: GalleryState, collapsed: boolean) => void
  setChatWidth: (draft: GalleryState, width: number) => void
  setChatHidden: (draft: GalleryState, hidden: boolean) => void
  setCanvasTool: (draft: GalleryState, tool: ImagineCanvasTool) => void
  setHistoryFilters: (draft: GalleryState, filters: HistoryFilters) => void
  placeMany: (draft: GalleryState, rects: readonly CanvasRect[]) => void
  regrid: (draft: GalleryState, ids: readonly string[]) => void
  inherit: (draft: GalleryState, from: string, to: string) => void
}

/**
 * Create the Imagine studio store.
 *
 * The whole state is persisted, `projects` and `placed` included, although
 * the host holds the shared copy of both: on a reload the rail, the open
 * project and its board are drawn from this copy at once, while the studio
 * (~1.2 MB) is still on its way, and `mergeProjects` folds this copy into the
 * host's — so an edit whose save had failed is still sent after a reload.
 * Saving only the preferences would start every page on an empty rail.
 * @returns the live store.
 */
export function createGalleryStore(): StoreInstance<GalleryState, GalleryActions> {
  return createStore({
    init: (): GalleryState => ({
      view: 'home',
      projectId: undefined,
      projects: [],
      railCollapsed: false,
      chatWidth: CHAT_DEFAULT,
      chatHidden: false,
      canvasTool: 'select',
      historyFilters: HISTORY_FILTERS_DEFAULT,
      placed: {},
      deleted: {},
    }),
    persist: 'dsh.comfy.imagine.v3',
    actions: {
      go: (d, view: ImagineStage) => {
        d.view = view
        d.projectId = undefined
      },
      openProject: (d, id: string) => {
        d.view = 'project'
        d.projectId = id
      },
      setProjects: (d, projects: readonly ImagineProject[]) => {
        d.projects = projects
      },
      upsertProject: (d, project: ImagineProject) => {
        const index = d.projects.findIndex(entry => entry.id === project.id)
        if (index < 0) {
          d.projects = [project, ...d.projects]
          return
        }
        d.projects = d.projects.map(entry => entry.id === project.id ? project : entry)
      },
      // Record the delete rather than leaving it implied: a merge with the
      // shared copy would otherwise bring the project straight back.
      purgeProjects: (d, ids: readonly string[], at: number) => {
        const gone = new Set(ids)
        if (gone.size === 0) return
        d.projects = d.projects.filter(entry => !gone.has(entry.id))
        for (const id of ids) d.deleted[id] = at
        if (d.projectId !== undefined && gone.has(d.projectId)) {
          d.projectId = undefined
          d.view = 'home'
        }
      },
      setDeleted: (d, deleted: ImagineTombstones) => {
        // Unchanged slices keep their reference: the page saves on a change
        // of reference, and every reload sets these.
        const keys = Object.keys(deleted)
        const same = keys.length === Object.keys(d.deleted).length
          && keys.every(id => d.deleted[id] === deleted[id])
        if (!same) d.deleted = { ...deleted }
        if (d.projects.some(entry => deleted[entry.id] !== undefined)) {
          d.projects = d.projects.filter(entry => deleted[entry.id] === undefined)
        }
      },
      setRailCollapsed: (d, collapsed: boolean) => { d.railCollapsed = collapsed },
      setChatHidden: (d, hidden: boolean) => { d.chatHidden = hidden },
      setChatWidth: (d, width: number) => {
        // The same bounds the page renders (CHAT_MIN/CHAT_MAX): clamping only
        // in CSS left the stored number free to drift below it, and the canvas
        // tool bar reads that number to dodge the column. A floor of 420 here
        // outlived the page's move to 200 and kept the drag from going under.
        d.chatWidth = clampChatWidth(width)
      },
      setCanvasTool: (d, tool: ImagineCanvasTool) => { d.canvasTool = tool },
      setHistoryFilters: (d, filters: HistoryFilters) => { d.historyFilters = filters },
      /*
       * One action for the whole board: placing it one tile at a time was one
       * store update (and, before the persist debounce of 2026-10-20, one
       * ~600 KB localStorage write) per tile.
       */
      placeMany: (d, rects: readonly CanvasRect[]) => {
        for (const rect of rects) {
          // A rect already stored as it is stays untouched, so a reload that
          // brings back the same positions changes nothing and saves nothing.
          const stored = d.placed[rect.id]
          if (stored !== undefined && stored.x === rect.x && stored.y === rect.y && stored.w === rect.w
            && stored.h === rect.h && stored.scale === rect.scale) continue
          d.placed[rect.id] = rect
        }
      },
      /*
       * Drop the manual positions of the named tiles so layoutCanvas repacks
       * them into the default grid. Scoped to the ids the caller passes —
       * `placed` is one map for every project, so emptying it reflowed boards
       * the user was not even looking at.
       */
      regrid: (d, ids: readonly string[]) => {
        for (const id of ids) Reflect.deleteProperty(d.placed, id)
      },
      inherit: (d, from: string, to: string) => {
        // An upscaled file takes the spot its source held, so the canvas does
        // not reshuffle around it. A no-op when there is nothing to inherit,
        // which is what makes it safe to call from an effect.
        const rect = d.placed[from]
        if (rect === undefined || from === to) return
        d.placed[to] = { ...rect, id: to }
        Reflect.deleteProperty(d.placed, from)
      },
    },
  })
}
