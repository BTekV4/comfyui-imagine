/**
 * Imagine studio: Grok-style home (rail, composer, templates) and project
 * (chat column + dotted free canvas). Layout follows grok.com/imagine.
 *
 * The page holds what its pieces share and wires them; the work lives in its
 * hooks (2026-10-25): `use-studio-sync` (the host: inventory, queue, studio,
 * ticks), `use-runner` (starting runs and reading written lines),
 * `use-project-naming`, `use-page-keys`, `use-file-ingest`, `use-width-drag`;
 * since 2026-11-07 also `use-address-sync` (the address, page and viewed
 * file), `use-board-model` (what the open board shows), `use-media-actions`
 * (what can be done to files) and `use-panel-state` (the home's panels).
 * What the composer holds is in its own store (`composer-store`), the reading
 * trace in another (`reading-trace`) and the jobs' progress in a third
 * (`job-progress`): a key typed, a token of thinking or a moving percentage
 * no longer draws the page.
 */

import { translate } from './locale-store.ts'
import type { ComfyLocaleKey } from './locales.ts'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import type { CanvasNote, ImagineProject } from '../../../shared/imagine-projects.ts'
import { HISTORY_PROJECT_ID } from '../../../shared/imagine-projects.ts'
import { IMAGINE_ASPECTS } from '../../../shared/imagine-media.ts'
import type { FrameCard } from './FrameExtractor.tsx'
import type { GalleryItem, ImagineAction } from '../../../shared/imagine-types.ts'
import type { WorkflowProposal } from '../../../shared/imagine-chat.ts'
import type { AgentPending } from '../../../shared/agent-chat.ts'
import type { HostAccessView } from '../../../shared/host-access.ts'
import { getJson, send } from './http.ts'
import { readDismissedScans, rememberDismissedScan } from './dismissed-scans.ts'
import { approveImagineSetup, uploadGalleryItem, startMusicClip, type SocialPost } from './gallery-api.ts'
import { CHAT_DEFAULT, CHAT_OLD_DEFAULT, CHAT_MAX, CHAT_MIN, type ImagineView } from './gallery-store.ts'
import {
  HISTORY_PAGE, createProject, lastUsedOf, nextUntitledTitle,
} from './imagine-projects.ts'
import { clampResolution, sizeFor, videoAspectLabel } from './imagine-settings.ts'
import { MusicClipPanel } from './MusicClipPanel.tsx'
import { HistoryFilterBar } from './HistoryFilterBar.tsx'
import { HistoryList } from './HistoryList.tsx'
import { filterHistory, HISTORY_FILTERS_DEFAULT, type HistoryFilters } from './imagine-filters.ts'
import { ProjectFiles } from './ProjectFiles.tsx'
import { ComposerBox } from './Composer.tsx'
import { createComposerStore } from './composer-store.ts'
import type { MediaActionKind } from './media-actions.tsx'
import { Viewer } from './Viewer.tsx'
import { Board, BoardToolbar, createCanvasSession, type BoardHandle } from './Board.tsx'
import { ChatColumn } from './ChatColumn.tsx'
import { Rail } from './Rail.tsx'
import { HomeView } from './HomeView.tsx'
import type { CustomWorkflow } from './custom-workflows-view.tsx'
import type { CustomBatchRequest, CustomRunRequest } from './custom-workflow-panel.tsx'
import type { Template } from '../../../shared/imagine-templates.ts'
import { ProjectsGrid } from './ProjectsGrid.tsx'
import { StageHeader } from './StageHeader.tsx'
import { AppFrame, type AppFrameView } from './AppFrame.tsx'
import { SelectionTools } from './SelectionTools.tsx'
import { Overlays, type Overlay, type UpscalePick } from './Overlays.tsx'
import { modeForKind, noteFromError } from './imagine-messages.ts'
import { createTraceStore } from './reading-trace.ts'
import { useRunner } from './use-runner.ts'
import { useStudioSync } from './use-studio-sync.ts'
import { useProjectNaming } from './use-project-naming.ts'
import { usePageKeys } from './use-page-keys.ts'
import { useFileIngest } from './use-file-ingest.ts'
import { useWidthDrag, type WidthDragStart } from './use-width-drag.ts'
import { useAddressSync } from './use-address-sync.ts'
import { useBoardModel } from './use-board-model.ts'
import { useMediaActions } from './use-media-actions.ts'
import { usePanelState } from './use-panel-state.ts'
import { NARROW_RAIL_QUERY, useMediaQuery } from './use-media-query.ts'
import { useEvent } from './use-event.ts'
import { APP_PLUGINS, INSTAGRAM_PLUGIN, usePluginEnabled } from './plugin-presence.ts'
import type { ImaginePageProps } from './props.ts'
import shared from './imagine-shared.module.css'
import css from './ImaginePage.module.css'

/*
 * The pages and panels off the canvas load on first use: one 520 KB bundle
 * made every visit pay for Social, Settings and the media wall up front.
 */
const PublishPanel = lazy(() => import('./PublishPanel.tsx').then(module => ({ default: module.PublishPanel })))
const SocialPage = lazy(() => import('./SocialPage.tsx').then(module => ({ default: module.SocialPage })))
const ImagineSettings = lazy(() => import('./ImagineSettings.tsx').then(module => ({ default: module.ImagineSettings })))
const HostSettings = lazy(() => import('../../src/HostSettings.tsx').then(module => ({ default: module.HostSettings })))
const PluginsPage = lazy(() => import('../../src/PluginsPage.tsx').then(module => ({ default: module.PluginsPage })))
const LibraryPage = lazy(() => import('./LibraryPage.tsx').then(module => ({ default: module.LibraryPage })))
const MediaPage = lazy(() => import('./MediaPage.tsx').then(module => ({ default: module.MediaPage })))

/*
 * Widest the chat gets on a narrow window — between the phone breakpoint and
 * the one where the rail becomes a drawer. The column floats over the board,
 * so it never takes width from the canvas, but a 560px panel over a 700px
 * window covers most of what it is floating on. Mirrors the `max-width` in the
 * 900px block of ChatColumn.module.css; the two must move together.
 */
const CHAT_NARROW_MAX = 320

/** The History board's notes: none, and the same empty list every render. */
const NO_NOTES: readonly CanvasNote[] = []

export function ImaginePage({ useStore, actions }: ImaginePageProps) {
  const view = useStore(state => state.view)
  const projectId = useStore(state => state.projectId)
  const projects = useStore(state => state.projects)
  const railCollapsed = useStore(state => state.railCollapsed)
  const storedChatWidth = useStore(state => state.chatWidth)
  const chatHidden = useStore(state => state.chatHidden)
  const canvasTool = useStore(state => state.canvasTool)
  /*
   * The History board's filters. A store persisted before this field existed has no
   * value for it, and the page reads the default rather than an undefined: the
   * engine restores the saved state whole, with no merge over `init`.
   */
  const historyFilters = useStore(state => state.historyFilters) ?? HISTORY_FILTERS_DEFAULT
  const saved = useStore(state => state.placed)
  const deleted = useStore(state => state.deleted)
  /*
   * The board's camera and zoom, outside React state: only the board and its
   * zoom pill subscribe (see Board.tsx). Not persisted either: every wheel
   * event rewrote the whole store to localStorage.
   */
  const [canvasSession] = useState(createCanvasSession)
  /**
   * What `/api/access` says about who may open this studio: the rail offers
   * "Log out" only when the login is on, and the page warns when a non-loopback
   * studio has no password. Hiding that warning is one choice for the studio,
   * so it is written to the host (Settings → Access brings it back). The
   * settings page says when to read all this again.
   */
  const [access, setAccess] = useState<HostAccessView>()
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void getJson<HostAccessView>('/api/access', 'HTTP')
        .then((next) => { if (alive) setAccess(next) }, () => undefined)
    }
    read()
    window.addEventListener('imagine:access-changed', read)
    return () => {
      alive = false
      window.removeEventListener('imagine:access-changed', read)
    }
  }, [])
  /** What the composer and the panels hold: see composer-store. */
  const [composer] = useState(createComposerStore)
  /** The trace of the reading in progress: see reading-trace. */
  const [trace] = useState(createTraceStore)
  /** The board, for the page's few calls into it (focus, shortcuts, Escape). */
  const boardApi = useRef<BoardHandle>(null)
  /** The dialog root, so the focus trap knows what "inside" means. */
  const pageRef = useRef<HTMLDivElement>(null)
  /** The home's own scroll box, which a card sends back to the composer. */
  const homeRef = useRef<HTMLDivElement>(null)
  const projectsRef = useRef(projects)
  projectsRef.current = projects

  const [selected, setSelected] = useState<GalleryItem | undefined>(undefined)
  /** How much of the history board is drawn; grows a page at a time. */
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE)
  const [picked, setPicked] = useState<readonly string[]>([])
  /*
   * The selection belongs to the board it was made on: kept across a switch
   * of project or page, Delete in Library or Settings offered to remove
   * files no longer on screen. Reset during render, not in an effect, so a
   * focus the switch itself asked for (a file opened from elsewhere) picks
   * its tile after the reset and stays picked.
   */
  const pickedOn = `${view}:${projectId ?? ''}`
  const [pickedBoard, setPickedBoard] = useState(pickedOn)
  if (pickedBoard !== pickedOn) {
    setPickedBoard(pickedOn)
    if (picked.length > 0) setPicked([])
  }
  /** The one thing open over the files: see Overlays. */
  const [overlay, setOverlay] = useState<Overlay | undefined>(undefined)
  /** The project page's pane, as Grok's bar above the canvas: the board or its files. */
  const [projectPane, setProjectPane] = useState<'canvas' | 'files'>('canvas')
  /** "Hide canvas": the chat alone, across the whole studio. */
  const [canvasHidden, setCanvasHidden] = useState(false)
  /** The list the viewer walks when it was opened from All media. */
  const [mediaList, setMediaList] = useState<readonly GalleryItem[] | undefined>(undefined)
  /*
   * The candidate sets whose block was closed with "Cancel", by scan job.
   *
   * The block is derived from the jobs, so without this a closed choice came
   * back at the next render — and on every reload. The answer is per browser
   * (`dismissed-scans.ts`): it is a preference, not something the project
   * should carry.
   */
  const [dismissedScans, setDismissedScans] = useState<Readonly<Record<string, number>>>(readDismissedScans)
  /*
   * The music-video form. A video clip is four runs in a fixed order and each
   * needs the names the previous produced, so it is asked for as one form and
   * chained by the host rather than typed as four sentences.
   */
  const [clipOpen, setClipOpen] = useState(false)
  /** The gallery item currently being published, or undefined when the panel is closed. */
  const [publishItem, setPublishItem] = useState<GalleryItem | undefined>(undefined)
  /** Multiple items for carousel publishing. */
  const [carouselItems, setCarouselItems] = useState<readonly GalleryItem[]>([])
  const [editingPost, setEditingPost] = useState<SocialPost | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [menuId, setMenuId] = useState<string | undefined>(undefined)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | undefined>(undefined)
  /*
   * Narrow layouts hide the rail outright, so the same button that collapses
   * it on a wide screen slides it in as a drawer here. Two attributes rather
   * than one shared state: each width reads only its own, so neither layout
   * inherits a toggle meant for the other.
   */
  const [railDrawer, setRailDrawer] = useState(false)
  /*
   * The layout in force, as a rendered fact rather than something read at
   * click time: the rail head's second button means "collapse" in a column
   * and "close" in a drawer, and it has to say which before it is pressed.
   * The RAIL's breakpoint, not the chat's: between 641 and 900 the rail is
   * `display: none` and only the drawer can bring it back.
   */
  const narrow = useMediaQuery(NARROW_RAIL_QUERY)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  /*
   * A written line is being read. Its own flag rather than `busy`: nothing is
   * on the GPU yet, the send button must go quiet all the same, and the column
   * says so.
   */
  const [reading, setReading] = useState(false)
  /*
   * The reading in flight, so the column can give up on it. There is no
   * deadline on the client and the server's is 45 seconds per candidate route.
   */
  const readingRef = useRef<AbortController | undefined>(undefined)
  // Abort a chat reading still in flight when the studio unmounts, so its
  // stream stops and no setState lands after the component is gone.
  useEffect(() => () => { readingRef.current?.abort() }, [])
  /*
   * A workflow change waiting for a yes. Kept in the page and not in the
   * project: nothing has been written yet, and an offer that outlived a reload
   * would be applied against a graph the user has not seen since.
   */
  const [proposal, setProposal] = useState<WorkflowProposal | undefined>(undefined)
  /**
   * The work the agent stopped before doing, waiting for a yes. Never
   * persisted: a reload loses it, because a pending action that outlived the
   * page would be a run nobody is looking at any more.
   */
  const [pending, setPending] = useState<AgentPending | undefined>(undefined)

  /*
   * Effective chat-column width; the chat floats over the board's left, so this
   * also frames the canvas to the right of it on open. Capped on a narrow
   * window: the number was dragged on a wide one. The stored width is
   * untouched, so widening the window gives it back.
   */
  const chatCap = narrow ? CHAT_NARROW_MAX : CHAT_MAX
  // Grok starts its chat at 400px (atlas-chat-width); 360 was this studio's old default.
  const liveChatWidth = Number.isFinite(storedChatWidth) && storedChatWidth !== CHAT_OLD_DEFAULT
    ? Math.min(chatCap, Math.max(CHAT_MIN, storedChatWidth))
    : Math.min(chatCap, CHAT_DEFAULT)
  /*
   * While the edge is dragged the width goes straight into the CSS variable
   * of the boxes that carry it (the studio and the bar above it), rounded and
   * clamped as the store will keep it; the page renders once, on release.
   */
  const chat = useWidthDrag(
    (width) => {
      const shown = `${String(Math.min(chatCap, Math.max(CHAT_MIN, Math.round(width))))}px`
      for (const node of pageRef.current?.querySelectorAll<HTMLElement>('[data-imagine-chat-w]') ?? []) {
        node.style.setProperty('--imagine-chat-w', shown)
      }
    },
    (width) => { actions.setChatWidth(width) },
  )


  const setNote = (note: string | undefined): void => { composer.set({ note }) }
  /**
   * An edit with Grok's «+» reference photo: the photo goes up to the gallery
   * first (the run names gallery files), then the edit runs with it.
   */
  const withReference = (reference: File | undefined, go: (ref: GalleryItem | undefined) => void): void => {
    if (reference === undefined) { go(undefined); return }
    uploadGalleryItem(reference).then(
      (uploaded) => { go(uploaded) },
      (error: unknown) => { setNote(error instanceof Error ? error.message : String(error)) },
    )
  }
  const patch = (project: ImagineProject): ImagineProject => {
    actions.upsertProject(project)
    return project
  }
  const naming = useProjectNaming(projectsRef, patch, () => composer.get().chatModel)

  /*
   * The Instagram UI belongs to its plugin: hidden, and not polled, once the
   * host says the plugin is absent or off. Until it answers the page shows
   * what it always did (the plugin is there in production), but asks the
   * queue nothing.
   */
  const instagram = usePluginEnabled(INSTAGRAM_PLUGIN)
  const socialOff = instagram === false
  /** The app pages opened so far: their frame stays mounted (AppFrame.tsx). */
  const [visitedApps, setVisitedApps] = useState<ReadonlySet<AppFrameView>>(() => new Set())
  useEffect(() => {
    if (view !== 'openjutsu' && view !== 'iopaint') return
    setVisitedApps(seen => (seen.has(view) ? seen : new Set([...seen, view])))
  }, [view])
  /*
   * Openjutsu and IOPaint are plugins too (2026-11-15): an app whose plugin
   * the host says is absent or off has no rail entry and no page. Until the
   * host answers they show, like Instagram.
   */
  const openjutsuOn = usePluginEnabled(APP_PLUGINS.openjutsu)
  const iopaintOn = usePluginEnabled(APP_PLUGINS.iopaint)
  const apps = useMemo<readonly AppFrameView[]>(
    () => (['openjutsu', 'iopaint'] as const).filter(app => (app === 'openjutsu' ? openjutsuOn : iopaintOn) !== false),
    [openjutsuOn, iopaintOn],
  )
  const unavailable = useMemo(() => {
    const off = new Set<ImagineView>()
    if (socialOff) off.add('social')
    if (openjutsuOn === false) off.add('openjutsu')
    if (iopaintOn === false) off.add('iopaint')
    return off.size === 0 ? undefined : off
  }, [socialOff, openjutsuOn, iopaintOn])
  const sync = useStudioSync({
    social: instagram === true,
    projects,
    projectsRef,
    placed: saved,
    deleted,
    actions,
    naming,
    patch,
    setNote,
    // Everything that pointed at the source follows it to the 2x instead of
    // being left on a file that no longer exists: the viewer, the composer's
    // starting image, and the batch selection.
    onRetire: (from, to, replacement) => {
      setSelected(shown => (shown?.name === from ? replacement : shown))
      composer.set(state => (state.sources.some(entry => entry.name === from)
        ? { sources: state.sources.map(entry => (entry.name === from ? replacement : entry)) }
        : {}))
      setPicked(chosen => (chosen.includes(from)
        ? [...new Set(chosen.map(name => (name === from ? to : name)))]
        : chosen))
    },
  })
  const { items, allByName, addItems, jobs, editJobs, status } = sync

  const current = projects.find(project => project.id === projectId)
  const { reload } = sync
  /*
   * Files can land in the media folder with no job of the studio behind them
   * (Openjutsu copies its finished videos there, 2026-11-10): opening All
   * media or the Library reads the folder again, so they show up at once.
   */
  useEffect(() => {
    if (view === 'media' || view === 'library') void reload()
  }, [view, reload])
  const {
    onHistory, historyItems, historyCounts, visible, visibleNames, historyLeft, historyEmpty, historyListed,
    ownLive, upscaling, scanChoice, ids, rects, itemsByName, liveById, pickedGroups,
  } = useBoardModel({
    view, current, items, jobs, status, reload, historyFilters, historyLimit, saved, dismissedScans, picked,
  })

  const listedEntries = useMemo(() => projects.filter((project) => {
    if (project.id === HISTORY_PROJECT_ID) return false
    const empty = project.itemNames.length === 0 && project.messages.length === 0
    if (empty) return false
    if (query.trim().length === 0) return true
    return project.title.toLowerCase().includes(query.trim().toLowerCase())
  }).map(project => ({ project, usedAt: lastUsedOf(project, name => allByName.get(name)?.mtime) }))
    // Pinned first, then most recently worked in: the order the user reaches for.
    .sort((a, b) => Number(b.project.pinned === true) - Number(a.project.pinned === true) || b.usedAt - a.usedAt),
  [projects, query, allByName])
  const listed = useMemo(() => listedEntries.map(entry => entry.project), [listedEntries])
  /** When each listed project was last worked in, computed once with the sort. */
  const usedAtById = useMemo(
    () => new Map(listedEntries.map(entry => [entry.project.id, entry.usedAt])),
    [listedEntries],
  )
  /**
   * The project each file sits on, the first that lists it; History is
   * never an owner. One map for the Library's cards and for every "open the
   * file where it lives".
   */
  const ownerOf = useMemo(() => {
    const owners = new Map<string, ImagineProject>()
    for (const project of projects) {
      if (project.id === HISTORY_PROJECT_ID) continue
      for (const name of project.itemNames) if (!owners.has(name)) owners.set(name, project)
    }
    return owners
  }, [projects])
  const libraryProjectOf = useCallback((name: string): string | undefined => ownerOf.get(name)?.title, [ownerOf])


  const runner = useRunner({
    actions, view, projectId, projects, current, composer, busy, setBusy, reading, setReading, readingRef,
    trace, editJobs, patch, naming, visible, ownLive, jobs, allByName, pickedGroups, setPicked, proposal, setProposal,
    pending, setPending,
    openClip: () => { setClipOpen(true) },
    reloadGallery: reload,
  })
  const { run, sendLine } = runner

  /**
   * Bring the chat back when something is staged into it, in a project: a
   * gesture on the home board must not undo a choice made about a project, and
   * a selection is not an action (see `stageSource`).
   */
  const revealChat = (): void => {
    if (view === 'project' && chatHidden) actions.setChatHidden(false)
  }
  /** Stage one file as the only source, or clear the staging. */
  const setSource = (next: GalleryItem | undefined): void => {
    composer.set({ sources: next === undefined ? [] : [next] })
  }
  /**
   * Stage a file AND bring the chat back for it: an action that puts the file
   * in the composer on purpose — remix, video, extend, an upload. Selecting a
   * tile on the board also stages it, but that must not reopen a column the
   * user pulled in (asked 2026-09-10).
   */
  const stageSource = (next: GalleryItem): void => {
    setSource(next)
    revealChat()
  }
  /** Stage every picked file, in the order picked; running jobs have no file yet. */
  const stagePicked = (list: readonly string[]): void => {
    composer.set({ sources: list.map(id => itemsByName.get(id)).filter((entry): entry is GalleryItem => entry !== undefined) })
  }

  const ingest = useFileIngest({
    composer, addItems, revealChat, patch,
    openOrCreate: runner.openOrCreate,
  })
  const { ingestFiles } = ingest

  const {
    panelCard, customPanel, openCustom, closeCustom, customWorkflows, homePanel, showPanel,
    changeMode, openPanel, closePanel, stageInSlot, uploadToSlot,
    templatePanel, openTemplate, closeTemplate,
  } = usePanelState({ view, composer, homeRef, addItems, setNote })
  /*
   * After the panels: the address names the home's open card too
   * (`/tool/<card>`, `/model/<id>`, `/workflow/<id>`).
   */
  useAddressSync({ actions, view, projectId, items, selected, setSelected, unavailable, panel: homePanel, showPanel })
  const {
    likes, merging, setPendingFocus, deleteItems, stageBatchVideo, placeOnBoard, likeMany, downloadMany,
    mergeSelection, stopJob, actOn, takeFrame,
  } = useMediaActions({
    actions, composer, busy, setBusy, setNote, current, projectsRef, patch, addItems, setItems: sync.setItems,
    editJobs, setSelected, setMediaList, setPicked, setOverlay, setPublishItem, setSource, stageSource, revealChat,
    changeMode, run, pickedGroups, boardApi, rects,
  })


  // Reset zoom when switching projects so the new canvas starts at 100%. The
  // camera is placed by the board, once the tiles are laid out; leaving the
  // project view lets the next opening frame again.
  useEffect(() => {
    if (view === 'project' && projectId !== undefined) canvasSession.set({ zoom: 1 })
    else canvasSession.framed = undefined
  }, [projectId, view, canvasSession])

  // A drawer left open would cover the project it was used to open.
  useEffect(() => { setRailDrawer(false) }, [view, projectId])

  // Each opening of the history board starts at the first page.
  /** How much of History a file opened from elsewhere needs drawn, for the next project switch. */
  const historyLimitWanted = useRef<number | undefined>(undefined)
  useEffect(() => {
    setHistoryLimit(historyLimitWanted.current ?? HISTORY_PAGE)
    historyLimitWanted.current = undefined
  }, [projectId])

  /*
   * Opening another project takes along only the staged files that belong to
   * it: a photo picked in one project stayed "in the chat's context" of the
   * next (2026-10-17). A file the switch itself staged (a history thumbnail
   * opening its project) is on that project's board and stays.
   */
  useEffect(() => {
    if (view !== 'project' || current === undefined) return
    composer.set((state) => {
      const kept = state.sources.filter(item => current.itemNames.includes(item.name))
      return kept.length === state.sources.length ? {} : { sources: kept }
    })
    // Deliberately keyed on the project switch: the sources of the old project go.
  }, [projectId])




  /**
   * Delete a project and persist it at once: the periodic save is a 400 ms
   * debounce whose cleanup clears the timer when the overlay closes, so
   * "delete, then close" never reached the server and the next merge brought
   * the project back. Write straight through, with the tombstone.
   */
  const deleteProject = (id: string): void => {
    const at = Date.now()
    const nextProjects = projects.filter(project => project.id !== id)
    const nextDeleted = { ...deleted, [id]: at }
    actions.purgeProjects([id], at)
    void sync.persist({ projects: nextProjects, placed: saved, deleted: nextDeleted })
  }

  /** Mint a fresh blank project and open it: "+" always creates a new entry. */
  const newBlankProject = (): void => {
    // The untitled number is a placeholder, not a name: the first line or run
    // the project gets asks the reading model to replace it.
    const project = runner.seedProject(createProject(nextUntitledTitle(projects, translate('imagine.untitled')), true))
    actions.upsertProject(project)
    actions.openProject(project.id)
  }



  /**
   * A thumbnail of the rail's recent strip, clicked: open the project that
   * holds the file and take the board to it.
   *
   * The strip is files, not projects, so the file may live on a board other
   * than the open one; `onOpenMessageFile` alone would put it ON this board.
   * @param name - the file's basename.
   */
  const onOpenRailFile = useEvent((name: string) => {
    if (!ownerOf.has(name)) {
      onOpenMessageFile(name)
      return
    }
    openFileInProject(name)
  })

  /**
   * Take the board to a file on its own project, selected, as a chat result
   * does; a file on no project is on History's.
   * @param name - the file's basename.
   */
  const openFileInProject = (name: string): void => {
    const owner = ownerOf.get(name)?.id ?? HISTORY_PROJECT_ID
    /*
     * History draws a page of its files, those its filters keep, as tiles: a
     * file further down, hidden by a filter or with History as a list was not
     * on the board, so the project opened and nothing was selected (reported
     * on 13-11-2026). Draw down to it, and drop the filters that hide it.
     */
    if (owner === HISTORY_PROJECT_ID) {
      let filters = historyFilters
      let at = filterHistory(items, filters, Date.now()).findIndex(item => item.name === name)
      if (at < 0 || filters.view === 'list') {
        filters = { ...filters, period: 'all', kinds: [], origins: [], view: 'grid' }
        at = filterHistory(items, filters, Date.now()).findIndex(item => item.name === name)
        actions.setHistoryFilters(filters)
      }
      if (at >= 0) {
        const limit = Math.max(HISTORY_PAGE, Math.ceil((at + 1) / HISTORY_PAGE) * HISTORY_PAGE)
        // Already on History the switch effect does not run: a limit left
        // for it would be applied at the next, unrelated, project switch.
        historyLimitWanted.current = projectId === HISTORY_PROJECT_ID ? undefined : limit
        setHistoryLimit(limit)
      }
    }
    // The board, not the Files pane or the chat alone: the file is shown on it.
    setProjectPane('canvas')
    if (canvasHidden) setCanvasHidden(false)
    if (owner !== projectId || view !== 'project') actions.openProject(owner)
    setSelected(undefined)
    setPendingFocus(name)
  }

  /**
   * The full-screen viewer for a file of "All media": on double click, or on
   * a single click on a file that sits in no project and so has no page to
   * lead to.
   * @param item - the file.
   * @param list - the open list, to walk the files with the arrow keys.
   */
  const openMediaViewer = useEvent((item: GalleryItem, list: readonly GalleryItem[]) => {
    setMediaList(list)
    setSelected(item)
    setSource(item)
  })


  /**
   * A line asked about one file (a tile's mini prompt, the viewer): the file
   * is staged, then the line is sent. The composer's store is set at once, so
   * the send reads the staging it was asked with — it used to wait a render
   * for it, through an effect.
   */
  const askAbout = (item: GalleryItem, text: string): void => {
    const { sources } = composer.get()
    if (sources.length !== 1 || sources[0]?.name !== item.name) composer.set({ sources: [item] })
    void sendLine(text, true)
  }

  /**
   * Repack the open board: forget the manual positions of the tiles on it, and
   * remember to tell the server, which never drops a position it is not asked
   * to drop.
   */
  const regridBoard = (): void => {
    const onBoard = ids.filter(id => saved[id] !== undefined)
    if (onBoard.length === 0) return
    sync.unplacedRef.current = [...new Set([...sync.unplacedRef.current, ...onBoard])]
    actions.regrid(onBoard)
  }


  /** A tile pressed on the board: the selection it leaves, staged for the composer. */
  const pressOnBoard = (id: string, nextPicked: readonly string[], additive: boolean): void => {
    setPicked(nextPicked)
    const item = itemsByName.get(id)
    if (item === undefined) return
    // An additive pick stages the whole selection, not the tile just
    // pressed: shift-clicking three stills and typing "put them together"
    // sent the chat one file, the last one clicked (2026-10-17).
    if (additive) stagePicked(nextPicked)
    else setSource(item)
    if (composer.get().mode !== 'look') composer.set({ mode: modeForKind(item.kind) })
  }

  /** One tile alone picked and staged: a focus, or a click collapsing a selection. */
  const selectOne = (id: string): void => {
    setPicked([id])
    const item = itemsByName.get(id)
    if (item !== undefined) setSource(item)
  }

  /** Grok's "Generate image/video" card sent: the run it describes. */
  const generateFromCard = (kind: 'image' | 'video', refs: readonly GalleryItem[], text: string): void => {
    const first = refs[0]
    if (kind === 'video') {
      if (first !== undefined) void run('video', first, text === '' ? {} : { prompt: text })
      return
    }
    // One photo selected makes the image an edit of it, as Grok's references do.
    if (first !== undefined) void run('remix', first, { prompt: text })
    else void run('generate', undefined, { prompt: text })
  }


  usePageKeys({
    view,
    picked,
    menuOpen: menuId !== undefined,
    renaming: renaming !== undefined,
    viewing: selected !== undefined,
    railDrawer,
    removeNamed: (names) => {
      void deleteItems(names.map(name => allByName.get(name)).filter((item): item is GalleryItem => item !== undefined))
    },
    closeMenu: () => { setMenuId(undefined) },
    stopRenaming: () => { setRenaming(undefined) },
    closeViewer: () => { setSelected(undefined) },
    clearPicked: () => { setPicked([]) },
    closeDrawer: () => { setRailDrawer(false) },
  }, pageRef, boardApi, canvasSession, actions)

  /*
   * Handlers that never change identity, for the memoized pieces: the board
   * and its tiles, the chat column, the rail, the composer, the header. Each
   * runs the render's own function, so it still sees the current state.
   */
  const onTileAction = useEvent((kind: MediaActionKind, item: GalleryItem, anchor?: DOMRect) => { actOn(kind, item, 'tile', anchor) })
  const onTileAsk = useEvent(askAbout)
  const onBoardPress = useEvent(pressOnBoard)
  const onBoardSelectOne = useEvent(selectOne)
  const onMarqueeEnd = useEvent(stagePicked)
  const onClearPick = useEvent(() => { setPicked([]); composer.set({ sources: [] }) })
  const onGenerate = useEvent(generateFromCard)
  const onNotesChange = useEvent((notes: readonly CanvasNote[]) => { if (current !== undefined) patch({ ...current, notes }) })
  const onTileMenu = useEvent((item: GalleryItem, event: ReactMouseEvent<HTMLElement>) => {
    setOverlay({ kind: 'menu', item, x: event.clientX, y: event.clientY, anchor: event.currentTarget.getBoundingClientRect() })
  })
  const onJobStop = useEvent((id: string) => { void stopJob(id) })
  const onApproveSetup = useEvent((id: string) => {
    approveImagineSetup(id).catch((error: unknown) => { setNote(noteFromError(error)) })
  })
  const onHistoryMore = useEvent(() => { setHistoryLimit(limit => limit + HISTORY_PAGE) })
  const onComposerMode = useEvent(changeMode)
  const onComposerUpload = useEvent((files: FileList | readonly File[]) => { void ingestFiles(files) })
  const onComposerSubmit = useEvent(() => { runner.submit() })
  const onOpenMessageFile = useEvent((name: string) => {
    /*
     * A file a chat line carried, clicked: on the board, go there and select
     * it. A file the line carried that is not on this board — the photo a run
     * started from, kept in another project — is put on it first, as Grok does
     * (asked 2026-10-17).
     */
    if (boardApi.current?.focus(name) === true) return
    const item = allByName.get(name)
    if (item === undefined) return
    if (current !== undefined && !current.itemNames.includes(item.name)) {
      placeOnBoard(item)
      return
    }
    setSelected(item)
  })
  const onChooseFrame = useEvent(runner.chooseFrame)
  /**
   * Close the block that offers a scan's candidates.
   *
   * Only the block: the pictures stay on the board, and a render already
   * started from it keeps going (its own Stop is in the live row). A new scan
   * has a new job id and gets its own block. Through useEvent like the
   * handlers above: a fresh closure here broke ChatColumn's memo on every
   * page render.
   */
  const onDismissChoose = useEvent((scanId: string): void => {
    setDismissedScans(rememberDismissedScan(scanId))
  })
  /** Empty the column. The project, its board and its files stay. */
  const onClearChat = useEvent(() => {
    if (current === undefined || current.messages.length === 0) return
    if (!globalThis.confirm(translate('imagine.confirmClearChat'))) return
    patch({ ...current, messages: [] })
  })
  const onHideChat = useEvent(() => { actions.setChatHidden(true) })
  const onRetryLine = useEvent((text: string) => { void sendLine(text, false) })
  /** Drop lines from the column, leaving the files they produced alone. */
  const onDeleteMessage = useEvent((gone: readonly string[]) => {
    if (current === undefined) return
    const drop = new Set(gone)
    patch({ ...current, messages: current.messages.filter(message => !drop.has(message.id)) })
  })
  const onApplyProposal = useEvent(() => { void runner.applyProposal() })
  const onCancelProposal = useEvent(() => { setProposal(undefined) })
  /** Answer the agent's offer: the turn resumes on the server. */
  const onConfirmAgent = useEvent((accept: boolean) => { void runner.confirmAgent(accept) })
  /** Give up on a reading that is not coming back. */
  const onStopReading = useEvent(() => { readingRef.current?.abort() })
  /*
   * Clamped to the same cap the column is rendered at, or the handle stops
   * following the pointer: on a narrow window the store would keep taking
   * wider numbers while the box stayed at CHAT_NARROW_MAX.
   */
  const onChatResize = useEvent((event: WidthDragStart) => { chat.start(event, liveChatWidth, width => Math.min(chatCap, width)) })
  // A click on the rail leaves the full-screen viewer and still does what it
  // was aimed at, so the viewer never hides the page it opened.
  const onLogout = useEvent(() => {
    // POST, so a link or an image cannot log the visitor out; the route clears
    // the cookie and lands on the form.
    void fetch('/logout', { method: 'POST', redirect: 'manual' })
      .catch(() => undefined)
      .finally(() => { location.assign('/login') })
  })
  const onRailClick = useEvent(() => { if (selected !== undefined) setSelected(undefined) })
  /**
   * Hide the warning about the open studio, on every device: the host writes
   * the choice, then every reader of `/api/access` hears about it. The
   * settings page offers the way back.
   */
  const onHideAccessWarning = useEvent(() => {
    void send<HostAccessView>('/api/access/banner/hide', 'POST', {}, 'HTTP')
      .then(() => { window.dispatchEvent(new Event('imagine:access-changed')) }, () => undefined)
  })
  const onCloseDrawer = useEvent(() => { setRailDrawer(false) })
  // From inside a workflow card too: "New generation" is the grid of tools.
  const onNewGeneration = useEvent(() => {
    closePanel()
    closeCustom()
    closeTemplate()
    actions.go('home')
  })
  const onNewProject = useEvent(newBlankProject)
  const onDeleteProject = useEvent(deleteProject)
  const onToggleRail = useEvent(() => {
    /*
     * The RAIL's breakpoint, not the chat's: between 641 and 900 the rail is
     * `display: none` and only the drawer can bring it back.
     */
    if (!narrow) {
      actions.setRailCollapsed(!railCollapsed)
      return
    }
    // The drawer always shows the full rail: a collapse carried over from a
    // wide session would render a 56px strip inside it.
    if (railCollapsed) actions.setRailCollapsed(false)
    setRailDrawer(shown => !shown)
  })
  const onHome = useEvent(() => { actions.go('home') })
  const onCanvasHidden = useEvent((hidden: boolean) => {
    setCanvasHidden(hidden)
    if (hidden && chatHidden) actions.setChatHidden(false)
  })
  const onToggleChat = useEvent(() => { actions.setChatHidden(!chatHidden) })
  const onCloseOverlay = useEvent(() => { setOverlay(undefined) })
  const onCard = useEvent(openPanel)
  /** Opens an uploaded card: its panel page, not the small panel on the home. */
  const onOpenCustom = useEvent(openCustom)
  const onBackCustom = useEvent(closeCustom)
  /** A «Models» card: its panel takes the home, as a flow card's does. */
  const onTemplate = useEvent((template: Template) => { openTemplate(template) })
  const onBackTemplate = useEvent(closeTemplate)
  /*
   * A model's run lands in a project like a composer run (`runTemplateForm`);
   * a composed file (a collage, a resize) is new on disk, so the gallery is
   * read again for its tile.
   */
  const onRunTemplate = useEvent(async (
    template: Template,
    request: { values: Record<string, string | string[]>; files: Record<string, string[]> },
  ) => {
    const answer = await runner.runTemplateForm({ id: template.id, title: translate(template.titleKey as ComfyLocaleKey) }, request)
    if (answer.started) void reload()
    return answer
  })
  const onRunCustomBatch = useEvent((workflow: CustomWorkflow, request: CustomRunRequest, batch: CustomBatchRequest) => {
    void runner.runCustomBatch(workflow, request, batch)
  })
  const onRunCustomJob = useEvent((workflow: CustomWorkflow, request: CustomRunRequest) => {
    void runner.run('custom', undefined, {
      prompt: request.prompt,
      customWorkflowId: workflow.id,
      ...Object.keys(request.customFields).length === 0 ? {} : { customFields: request.customFields },
      ...Object.keys(request.customFiles).length === 0 ? {} : { customFiles: request.customFiles },
    })
  })
  const onPanelBack = useEvent(() => { closePanel(); composer.set({ note: undefined, sources: [] }) })
  const onPanelStage = useEvent(stageInSlot)
  const onPanelUpload = useEvent(uploadToSlot)
  const onPanelRun = useEvent(runner.runPanel)
  const onFrameSaved = useEvent((item: GalleryItem) => { addItems([item]) })
  const onUseFrame = useEvent((item: GalleryItem, card: FrameCard) => {
    openPanel(card)
    composer.set({ sources: [item] })
  })
  const onSelectionDownload = useEvent(() => { void downloadMany(pickedGroups.items) })
  const onSelectionUpscale = useEvent((event: ReactMouseEvent<HTMLButtonElement>) => {
    setOverlay({ kind: 'upscale', items: pickedGroups.upscalable, anchor: event.currentTarget.getBoundingClientRect(), batch: true })
  })
  const onSelectionVideo = useEvent(stageBatchVideo)
  const onSelectionPublish = useEvent(() => { setCarouselItems(pickedGroups.stills.slice(0, 10)) })
  const onSelectionMerge = useEvent(() => { void mergeSelection() })
  const onSelectionDelete = useEvent(() => { void deleteItems(pickedGroups.items) })
  const onSelectionClear = useEvent(() => { setPicked([]) })

  const composerBusy = busy !== undefined || reading
  const docked = view === 'project'
  /** Openjutsu or IOPaint on screen: drops go to the app, not to the studio. */
  const onAppPage = view === 'openjutsu' || view === 'iopaint'
  const composerNode = useMemo(() => (
    <ComposerBox
      store={composer}
      busy={composerBusy}
      docked={docked}
      onMode={onComposerMode}
      onUpload={onComposerUpload}
      onSubmit={onComposerSubmit}
    />
  ), [composer, composerBusy, docked, onComposerMode, onComposerUpload, onComposerSubmit])

  /** The selection bar's buttons; the board places the bar under the picked tiles. */
  const selectionTools = useMemo(() => (
    <SelectionTools
      groups={pickedGroups}
      busy={busy !== undefined}
      merging={merging}
      onDownload={onSelectionDownload}
      onUpscale={onSelectionUpscale}
      onVideo={onSelectionVideo}
      onPublish={socialOff ? undefined : onSelectionPublish}
      onMerge={onSelectionMerge}
      onDelete={onSelectionDelete}
      onClear={onSelectionClear}
    />
  ), [pickedGroups, busy, merging, onSelectionDownload, onSelectionUpscale, onSelectionVideo, onSelectionPublish, socialOff,
    onSelectionMerge, onSelectionDelete, onSelectionClear])

  const more = useMemo(
    () => (onHistory && historyLeft > 0 ? { count: Math.min(HISTORY_PAGE, historyLeft), total: historyLeft } : undefined),
    [onHistory, historyLeft],
  )

  /** What the publish panel is open on: one file, a carousel, or a queued post. */
  const publishAsk = publishItem !== undefined
    ? { kind: 'item', props: { item: publishItem } }
    : carouselItems.length > 1
      ? { kind: 'carousel', props: { items: carouselItems } }
      : editingPost !== undefined ? { kind: 'post', props: { post: editingPost } } : undefined
  const pendingPosts = socialOff
    ? undefined
    : sync.socialPosts.filter(p => p.status === 'draft' || p.status === 'scheduled' || p.status === 'error').length

  return (
    <div
      ref={pageRef}
      className={css.page}
      data-imagine-page
      data-rail-collapsed={railCollapsed || undefined}
      data-rail-drawer={railDrawer || undefined}
      role="dialog"
      aria-modal="true"
      aria-label={translate('imagine.title')}
      onDragEnter={(event) => {
        event.preventDefault()
        event.stopPropagation()
        // On an app's page the drop belongs to the app in the frame: the
        // studio's own veil covered it and took the file (2026-11-13). Off the
        // frame (the rail) the file is refused rather than opened by the browser.
        if (onAppPage) { event.dataTransfer.dropEffect = 'none'; return }
        event.dataTransfer.dropEffect = 'copy'
        ingest.setDropping(true)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = onAppPage ? 'none' : 'copy'
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return
        ingest.setDropping(false)
      }}
      onDrop={(event) => {
        if (onAppPage) { event.preventDefault(); event.stopPropagation(); ingest.setDropping(false); return }
        ingest.takeDrop(event)
      }}
    >
      <Overlays
        overlay={overlay}
        busy={busy !== undefined}
        project={current}
        onClose={onCloseOverlay}
        onAction={(kind, item, anchor) => { actOn(kind, item, 'menu', anchor) }}
        onPlace={placeOnBoard}
        onRegion={(photo, prompt, zone) => { void run('remix', photo, { prompt, ...zone }) }}
        onUseFrame={takeFrame}
        onReuse={(text, from) => {
          const start = from === undefined ? undefined : allByName.get(from)
          composer.set({ ...start === undefined ? {} : { sources: [start] }, prompt: text })
          revealChat()
        }}
        onOpenSource={(name) => {
          if (boardApi.current?.focus(name) === true) return
          const source = allByName.get(name)
          if (source !== undefined) setSelected(source)
        }}
        onUpscale={(ask, to: UpscalePick) => {
          if (ask.batch) {
            void runner.runBatchUpscale(to)
            return
          }
          const item = ask.items[0]
          if (item === undefined) return
          const upscaleTo = item.kind === 'video' ? to.video : to.image
          if (selected?.name === item.name) setSelected(undefined)
          void run('upscale', item, upscaleTo === undefined ? {} : { upscaleTo })
        }}
      />
      {ingest.dropping && <div className={css.dropHint}>{translate('imagine.dropHere')}</div>}
      <Rail
        actions={actions}
        view={view}
        projectId={projectId}
        railCollapsed={railCollapsed}
        narrow={narrow}
        listed={listed}
        usedAtById={usedAtById}
        query={query}
        onQuery={setQuery}
        renaming={renaming}
        onRenaming={setRenaming}
        menuId={menuId}
        onMenuId={setMenuId}
        pendingPosts={pendingPosts}
        apps={apps}
        items={items}
        onOpenFile={onOpenRailFile}
        onRailClick={onRailClick}
        onCloseDrawer={onCloseDrawer}
        onNewGeneration={onNewGeneration}
        onNewProject={onNewProject}
        onDeleteProject={onDeleteProject}
        canLogout={access?.loginRequired === true}
        onLogout={onLogout}
      />

      <div className={css.stage}>
        {access !== undefined && access.exposed && !access.loginRequired && !access.bannerDismissed && (
          <div className={css.accessWarning} role="status">
            <span>{translate('imagine.access.exposed', { host: access.listenHost })}</span>
            <button type="button" className={css.accessWarningAction} onClick={() => { actions.go('settings') }}>
              {translate('imagine.access.openSettings')}
            </button>
            <button
              type="button"
              className={css.accessWarningAction}
              title={translate('imagine.access.hide')}
              onClick={onHideAccessWarning}
            >
              {translate('imagine.access.hide')}
            </button>
          </div>
        )}
        <StageHeader
          view={view}
          hasProject={current !== undefined}
          onHistory={onHistory}
          canvasHidden={canvasHidden}
          chatHidden={chatHidden}
          projectPane={projectPane}
          railDrawer={railDrawer}
          chatWidth={liveChatWidth}
          saveFailed={sync.saveFailed}
          onToggleRail={onToggleRail}
          onHome={onHome}
          onPane={setProjectPane}
          onCanvasHidden={onCanvasHidden}
          onToggleChat={onToggleChat}
          onNewProject={onNewProject}
        />

        {view === 'home' && (
          <HomeView
            store={composer}
            busy={composerBusy}
            panelCard={panelCard}
            customPanel={customPanel}
            customWorkflows={customWorkflows}
            onOpenCustom={onOpenCustom}
            onBackCustom={onBackCustom}
            onRunCustomJob={onRunCustomJob}
            onRunCustomBatch={onRunCustomBatch}

            templatePanel={templatePanel}
            onTemplate={onTemplate}
            onBackTemplate={onBackTemplate}
            onRunTemplate={onRunTemplate}

            items={items}
            composer={composerNode}
            homeRef={homeRef}
            onCard={onCard}
            onBack={onPanelBack}
            onStage={onPanelStage}
            onUpload={onPanelUpload}
            onRun={onPanelRun}
            onFrameSaved={onFrameSaved}
            onUseFrame={onUseFrame}
          />
        )}

        <Suspense fallback={null}>
        {view === 'social' && !socialOff && (
          <SocialPage posts={sync.socialPosts} onOpen={setEditingPost} />
        )}

        {view === 'media' && (
          <MediaPage
            items={items}
            liked={likes}
            onLike={likeMany}
            onBack={() => { actions.go('home') }}
            /*
             * A click on a file leads to the project that holds it, as the
             * Library does since 2026-11-04: the full-screen viewer opens on
             * double click (or from the project, by clicking the tile).
             *
             * A file that sits in no project goes to History, where it is
             * anyway and where the file stays selected: the viewer used to
             * open, and whoever clicked a reel made outside the studio (no
             * note, no project) was left without a page and without knowing
             * where it had ended up (reported on 5-11-2026).
             */
            onOpen={(item) => { openFileInProject(item.name) }}
            onOpenViewer={openMediaViewer}
            onCreateVideo={(item) => { actOn('video', item, 'tile') }}
            onDownload={(chosen) => { void downloadMany(chosen) }}
            onDelete={(doomed) => { void deleteItems(doomed) }}
            suspended={selected !== undefined}
            composer={composerNode}
          />
        )}

        {view === 'library' && (
          <LibraryPage
            items={items}
            projectOf={libraryProjectOf}
            onOpen={(item) => { openFileInProject(item.name) }}
            onUpload={(files) => { void ingest.uploadToLibrary(files) }}
          />
        )}

        {view === 'settings' && (
          <ImagineSettings
            onOpenPlugins={() => { actions.go('plugins') }}
            lead={{
              models: onPending => <HostSettings sections="models" onPending={onPending} />,
              access: onPending => <HostSettings sections="social" onPending={onPending} />,
            }}
          />
        )}

        {view === 'plugins' && <PluginsPage />}
        </Suspense>

        {/* Mounted at the first visit and then only hidden: no reload coming back. */}
        {apps.map(app => (visitedApps.has(app) || view === app) && (
          <AppFrame key={app} app={app} shown={view === app} items={items} liked={likes} />
        ))}

        {view === 'projects' && (
          <ProjectsGrid listed={listed} allByName={allByName} onOpen={actions.openProject} />
        )}

        {view === 'project' && current !== undefined && (
          <div
            /*
             * The dragged width travels as a custom property, not as inline
             * flex-basis/width: an inline value beats every media query, and on
             * a phone `.studio` turns into a column, where that same number
             * stops being a width and becomes a HEIGHT. It rides on the studio,
             * not on the column, because the canvas tool bar has to dodge that
             * column too and is not its descendant. Zero while the column is
             * away: it floats over the board, so the board is already full
             * width and an offset would only push those controls off centre.
             */
            className={css.studio}
            data-imagine-studio
            data-imagine-chat-w={chatHidden ? undefined : true}
            style={{ '--imagine-chat-w': chatHidden ? '0px' : `${String(liveChatWidth)}px` } as CSSProperties}
            data-canvas-hidden={canvasHidden || undefined}
          >
            {!chatHidden && (
              <ChatColumn
                project={current}
                picked={picked}
                ownLive={ownLive}
                reading={reading}
                busy={busy !== undefined}
                trace={trace}
                proposal={proposal}
                pending={pending}
                onConfirm={onConfirmAgent}
                choose={scanChoice}
                composer={composerNode}
                onOpenFile={onOpenMessageFile}
                onChooseFrame={onChooseFrame}
                onDismissChoose={onDismissChoose}
                onClearChat={onClearChat}
                onHideChat={onHideChat}
                onRetry={onRetryLine}
                onDeleteMessage={onDeleteMessage}
                onApplyProposal={onApplyProposal}
                onCancelProposal={onCancelProposal}
                onStopReading={onStopReading}
                onStopJob={onJobStop}
                onApproveSetup={onApproveSetup}
                onResizeStart={onChatResize}
              />
            )}
            {projectPane === 'files' && !canvasHidden && (
              <ProjectFiles
                items={visible}
                onFullscreen={(item) => { setSelected(item); setSource(item) }}
                onShowOnCanvas={(item) => { setProjectPane('canvas'); setPendingFocus(item.name) }}
              />
            )}
            <div className={css.stage}>
              {onHistory && historyCounts !== undefined && (
                <HistoryFilterBar
                  filters={historyFilters}
                  counts={historyCounts}
                  total={items.length}
                  shown={historyItems.length}
                  onChange={(next: HistoryFilters) => { actions.setHistoryFilters(next) }}
                />
              )}
              {historyEmpty && (
                <div className={css.historyEmpty}>
                  <p className={shared.note}>{translate('imagine.filterEmpty')}</p>
                  <button
                    type="button"
                    className={css.historyMore}
                    onClick={() => {
                      actions.setHistoryFilters({ ...historyFilters, period: 'all', kinds: [], origins: [] })
                    }}
                  >
                    {translate('imagine.filterClear')}
                  </button>
                </div>
              )}
              {historyListed && (
                <HistoryList
                  items={visible}
                  onOpen={(item: GalleryItem) => { setSelected(item); setSource(item) }}
                  more={historyLeft}
                  onMore={onHistoryMore}
                />
              )}
              {!historyEmpty && !historyListed && (
                <Board
                  ref={boardApi}
                  session={canvasSession}
                  projectId={projectId}
                  ownBoard={!onHistory}
                  rects={rects}
                  itemsByName={itemsByName}
                  liveById={liveById}
                  visibleNames={visibleNames}
                  picked={picked}
                  busy={busy}
                  suspended={selected !== undefined}
                  upscaling={upscaling}
                  canvasTool={canvasTool}
                  chatWidth={liveChatWidth}
                  status={status}
                  dropping={ingest.dropping}
                  notes={onHistory ? undefined : current.notes ?? NO_NOTES}
                  selectionTools={selectionTools}
                  more={more}
                  onMore={onHistoryMore}
                  onPress={onBoardPress}
                  onSelectOne={onBoardSelectOne}
                  onPicked={setPicked}
                  onMarqueeEnd={onMarqueeEnd}
                  onClearPick={onClearPick}
                  onPlace={actions.placeMany}
                  onNotesChange={onNotesChange}
                  onGenerate={onGenerate}
                  onTileAction={onTileAction}
                  onTileAsk={onTileAsk}
                  onTileMenu={onTileMenu}
                  onJobStop={onJobStop}
                />
              )}
              {/*
                * Inside the canvas, not beside it: the bar is anchored to
                * the bottom of its container, and on a phone — where the chat
                * is a band at the bottom of the screen — outside the canvas
                * it would have ended up over the composer.
                */}
              {!historyListed && !historyEmpty && projectPane === 'canvas' && !canvasHidden && (
                <BoardToolbar
                  session={canvasSession}
                  board={boardApi}
                  tool={canvasTool}
                  ownBoard={!onHistory}
                  onTool={(next) => { actions.setCanvasTool(next) }}
                  onUpload={(files) => { void ingestFiles(files) }}
                  onRegrid={regridBoard}
                />
              )}
            </div>
          </div>
        )}

        {selected !== undefined && (
          <Viewer
            items={view === 'media' && mediaList !== undefined ? mediaList : visible}
            liked={likes.has(selected.name)}
            current={selected}
            busy={busy === selected.name}
            onPick={(item) => {
              setSelected(item)
              setSource(item)
              if (composer.get().mode !== 'look') composer.set({ mode: modeForKind(item.kind) })
            }}
            onClose={() => { setSelected(undefined) }}
            onAction={(kind, item, anchor) => { actOn(kind, item, 'viewer', anchor) }}
            onRegion={(photo, prompt, zone, reference) => {
              setSelected(undefined)
              withReference(reference, (ref) => { void run('remix', photo, { prompt, ...zone, ...ref === undefined ? {} : { reference: ref } }) })
            }}
            onEdit={(photo, prompt, reference) => {
              setSelected(undefined)
              withReference(reference, (ref) => { void run('remix', photo, { prompt, ...ref === undefined ? {} : { reference: ref } }) })
            }}
            onCropped={(item) => { placeOnBoard(item); setSelected(item) }}
            onSketch={(photo, sketch, mask, prompt) => {
              // «Draw»: the photo with the sketch on it goes up as a file of
              // its own (Grok uploads its drawing.png too), then the sketch's
              // zone of it is finished by «Precise edit».
              setSelected(undefined)
              const name = `sketch-${photo.name.replace(/\.[^.]+$/, '').slice(0, 40)}-${Date.now().toString(36)}.png`
              uploadGalleryItem(new File([sketch], name, { type: 'image/png' })).then(
                (uploaded) => { void run('remix', uploaded, { prompt, mask }) },
                (error: unknown) => { setNote(error instanceof Error ? error.message : String(error)) },
              )
            }}
            onAsk={(text) => { const file = selected; setSelected(undefined); askAbout(file, text) }}
            onRerun={(origin, text) => {
              // The same run again, with the edited words: from the file it
              // started from when it had one, onto the board like any run.
              const from = origin.source === undefined ? undefined : allByName.get(origin.source)
              setSelected(undefined)
              const action = origin.action as ImagineAction
              if ((action === 'remix' || action === 'video' || action === 'loop' || action === 'extend') && from === undefined) {
                setNote(translate('imagine.sourceGone'))
                return
              }
              // Same shape and length it was made with, when the note says.
              const aspect = IMAGINE_ASPECTS.find(entry => origin.aspect?.startsWith(entry))
              void run(action, from, {
                prompt: text,
                ...aspect === undefined ? {} : { aspect },
                ...origin.seconds === undefined ? {} : { seconds: origin.seconds },
              })
            }}
          />
        )}
      </div>
      {clipOpen && (
        <div className={css.publishOverlay}>
          <MusicClipPanel
            aspect={composer.get().aspect}
            onClose={() => { setClipOpen(false) }}
            onStart={async (form) => {
              try {
                /*
                 * A project of its own per video, unless one is open: the
                 * title-matching reuse of `openOrCreate` put every video made
                 * from the home into the same "Music video" board. The look's
                 * own title is already the name of the video it is going to
                 * hold: a settled title, so the naming pass does not shorten it.
                 */
                const owner = current ?? (() => {
                  const project = runner.seedProject(createProject(`${form.look} · ${translate('imagine.makeClip')}`, false))
                  actions.upsertProject(project)
                  actions.openProject(project.id)
                  return project
                })()
                const { chatModel, resolution } = composer.get()
                const plan = await startMusicClip({
                  ...form,
                  // No length is sent: the host reads it off the words. The
                  // full label, not "9:16": the graph's ratio is a
                  // closed list and a short name is rejected as not in it.
                  aspectRatio: videoAspectLabel(form.aspect),
                  size: sizeFor(form.aspect, clampResolution('look', resolution)),
                  ...chatModel === undefined ? {} : { model: chatModel },
                  // Named so the host adopts every wave into it: a reload
                  // between the waves used to lose the song and the shots.
                  projectId: owner.id,
                })
                setClipOpen(false)
                sync.startClipChain(plan.clipId, owner.id)
                setNote(translate('imagine.clipQueued', { shots: plan.shots }))
                await reload()
                void sync.reloadJobs()
              } catch (error: unknown) {
                setNote(noteFromError(error))
              }
            }}
          />
        </div>
      )}
      <Suspense fallback={null}>
      {publishAsk !== undefined && (
        <div className={css.publishOverlay}>
          <PublishPanel
            key={publishAsk.kind}
            {...publishAsk.props}
            jobs={jobs}
            onClose={() => { setPublishItem(undefined); setCarouselItems([]); setEditingPost(undefined) }}
            onChanged={sync.reloadPosts}
          />
        </div>
      )}
      </Suspense>
    </div>
  )
}
