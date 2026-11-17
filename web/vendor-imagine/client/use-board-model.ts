/**
 * What the open board shows, worked out from the project, the inventory and
 * the queue: the files on it (the History's through its filters), the runs
 * still going, the scan whose candidates are on offer, and the laid-out
 * tiles. Split out of ImaginePage.tsx (2026-11-07); every value is memoized
 * on what it reads, as it was in the page.
 * @module use-board-model
 */

import { useEffect, useMemo, useRef } from 'react'
import type { CanvasRect, ImagineProject } from '../../../shared/imagine-projects.ts'
import { HISTORY_PROJECT_ID } from '../../../shared/imagine-projects.ts'
import type { GalleryItem, ImagineJobView as ImagineJob } from '../../../shared/imagine-types.ts'
import { canvasOrder, layoutCanvas, runGroups } from './canvas-layout.ts'
import { askToLook, boardJobs, jobIsLive, upscalesInFlight } from './gallery-api.ts'
import { claimsTile } from './job-tiles.ts'
import type { ImagineView } from './gallery-store.ts'
import { filterHistory, historyKindCounts, kindCounts, type HistoryFilters } from './imagine-filters.ts'
import { runGapOf } from './imagine-messages.ts'
import { itemRatio, jobRatio } from './imagine-settings.ts'
import { groupPicked } from './SelectionTools.tsx'

/** What the board model reads of the page. */
export interface BoardModelContext {
  readonly view: ImagineView
  /** The open project, if any. */
  readonly current: ImagineProject | undefined
  readonly items: readonly GalleryItem[]
  readonly jobs: readonly ImagineJob[]
  readonly status: 'idle' | 'loading' | 'error'
  /** Read the inventory again. */
  readonly reload: () => Promise<void>
  readonly historyFilters: HistoryFilters
  /** How much of the history board is drawn. */
  readonly historyLimit: number
  /** The tiles' saved positions. */
  readonly saved: Readonly<Record<string, CanvasRect>>
  /** Scan jobs whose choice block was closed. */
  readonly dismissedScans: Readonly<Record<string, number>>
  readonly picked: readonly string[]
}

export function useBoardModel({
  view, current, items, jobs, status, reload, historyFilters, historyLimit, saved, dismissedScans, picked,
}: BoardModelContext) {
  const onHistory = current !== undefined && current.id === HISTORY_PROJECT_ID
  /*
   * The History is the one board the filter bar acts on: its files are the
   * whole inventory, so what it shows is the filter's result. Worked out only
   * while the History is open: it runs over every file.
   */
  const historyItems = useMemo(
    () => (onHistory ? filterHistory(items, historyFilters, Date.now()) : []),
    [onHistory, items, historyFilters],
  )
  /** Files each kind seat would keep, so its chip can carry a count. */
  const historyCounts = useMemo(
    () => {
      if (!onHistory) return undefined
      // With no kind picked (the default) the counted set is the one just
      // drawn: count it instead of filtering the inventory a second time.
      if (historyFilters.kinds.length === 0) return kindCounts(historyItems)
      return historyKindCounts(items, historyFilters, Date.now())
    },
    [onHistory, items, historyFilters, historyItems],
  )
  // Keyed on the id and the file list, not on the project: a chat line makes
  // a new project record and used to lay the board out again.
  const currentId = current?.id
  const currentNames = current?.itemNames

  const visible = useMemo(() => {
    if (currentId === undefined || currentNames === undefined) return []
    if (currentId === HISTORY_PROJECT_ID) return historyItems.slice(0, historyLimit)
    const names = new Set(currentNames)
    return items.filter(item => names.has(item.name))
  }, [currentId, currentNames, items, historyItems, historyLimit])
  const visibleNames = useMemo(() => visible.map(item => item.name), [visible])
  // A page of the filter's result, not of the inventory: the board asks for
  // more of what it is showing.
  const historyLeft = Math.max(0, historyItems.length - historyLimit)
  const historyEmpty = onHistory && items.length > 0 && historyItems.length === 0
  const historyListed = onHistory && historyFilters.view === 'list' && !historyEmpty
  /*
   * The project lists files and the board has none of them: the inventory in
   * hand is not the one on disk. Read it again rather than leaving an empty
   * canvas that only a page reload fills. Keyed on the transition, so a
   * project whose files really are gone costs one read, not a loop.
   */
  const starved = view === 'project' && status === 'idle' && current !== undefined
    && current.id !== HISTORY_PROJECT_ID && current.itemNames.length > 0 && visibleNames.length === 0
  useEffect(() => {
    if (!starved) return undefined
    const handle = globalThis.setTimeout(() => { void reload() }, 1000)
    return () => { globalThis.clearTimeout(handle) }
  }, [starved, reload])
  /*
   * The board's stills are looked at when the project opens, not when a line
   * mentions them: by the time "these photos" is written the descriptions are
   * on file. Newest first and a bounded number, since the host looks at each
   * one it has not seen; debounced so a burst of inventory reloads posts once.
   */
  const stillsToSee = visible.filter(item => item.kind === 'image').slice(0, 60).map(item => item.name).join('\n')
  useEffect(() => {
    if (stillsToSee.length === 0) return undefined
    const handle = setTimeout(() => { void askToLook(stillsToSee.split('\n')) }, 800)
    return () => { clearTimeout(handle) }
  }, [stillsToSee])
  const currentJobIds = current?.jobIds
  const ownLive = useMemo(
    () => {
      // A Set, so a long project is not scanned once per job in the queue.
      const own = new Set(currentJobIds)
      return jobs.filter(job => jobIsLive(job) && own.has(job.id))
    },
    [jobs, currentJobIds],
  )
  // An upscale draws on the tile it is replacing rather than claiming one of
  // its own, and a story's preparation job — the one that measures the track's
  // voice before the shots exist — has nothing to draw yet; every other action
  // still gets a placeholder (see `claimsTile`).
  const liveJobs = useMemo(() => boardJobs(ownLive).filter(claimsTile), [ownLive])
  const upscaling = useMemo(() => upscalesInFlight(ownLive), [ownLive])
  /*
   * "Recreate video" in two halves: the scan draws the candidate frames and
   * the recreation starts when one of them is clicked. This
   * is the newest finished scan of this project, read off the jobs rather
   * than kept in the page, so a scan that finished while the tab was closed
   * still offers its set and a reload changes nothing. `chosen` is a run
   * already queued from one of these frames: the block then says which one
   * was used and stays available for a second take.
   */
  const scanChoice = useMemo(() => {
    if (current === undefined) return undefined
    const owned = new Set(current.jobIds)
    const scans = jobs
      .filter(job => job.action === 'scanFrame' && job.status === 'done'
        && owned.has(job.id) && job.source !== undefined && dismissedScans[job.id] === undefined)
      .sort((a, b) => b.createdAt - a.createdAt)
    const scan = scans[0]
    if (scan === undefined) return undefined
    const candidates = (scan.files ?? []).filter(file => file.kind === 'image').map(file => file.name)
    if (candidates.length === 0) return undefined
    const used = jobs.find(job => job.action === 'recreate' && job.frame !== undefined && candidates.includes(job.frame))
    const chosen = used?.frame
    return {
      id: scan.id,
      candidates,
      ...chosen === undefined ? {} : { chosen, live: jobIsLive(used as ImagineJob) },
      ...scan.prompt.trim().length === 0 ? {} : { scene: scan.prompt.trim() },
    }
  }, [current, jobs, dismissedScans])
  /*
   * The layout reads only which jobs are live, never their progress: keyed on
   * the ids, a job's tick does not lay the whole board out again.
   */
  const liveKey = liveJobs.map(job => job.id).join('\n')
  const ids = useMemo(
    () => canvasOrder(visible.map(item => item.name), liveJobs.map(job => job.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on liveKey
    [liveKey, visible],
  )
  /*
   * The board is a world with its own coordinates, as Grok Imagine's is: the
   * layout is measured on it, not on the window or the zoom. A tile is drawn
   * at its media's own aspect; a live job uses the size it was submitted
   * with, so its placeholder does not resize under the cursor when the file
   * lands.
   */
  const ratios = useMemo(() => {
    const byId: Record<string, number> = {}
    for (const item of visible) {
      const ratio = itemRatio(item)
      if (ratio !== undefined) byId[item.name] = ratio
    }
    for (const job of liveJobs) {
      const ratio = jobRatio(job)
      if (ratio !== undefined) byId[job.id] = ratio
    }
    return byId
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on liveKey
  }, [visible, liveKey])
  /** Which story each delivered shot belongs to; the same map while no story changes. */
  const storyRef = useRef<{ key: string; byFile: ReadonlyMap<string, string> }>({ key: '', byFile: new Map() })
  const storyByFile = useMemo(() => {
    const byFile = new Map<string, string>()
    for (const job of jobs) {
      if (job.storyId === undefined) continue
      for (const file of job.files ?? []) byFile.set(file.name, `s:${job.storyId}`)
    }
    const key = [...byFile].join('|')
    if (key !== storyRef.current.key) storyRef.current = { key, byFile }
    return storyRef.current.byFile
  }, [jobs])
  /*
   * Which run each tile belongs to, for the one-row-per-run layout: files of
   * the same kind of job made one after the other (see runGapOf) share a row,
   * and a story's shots stay together whatever the gaps. Tiles still being
   * made share the last row.
   */
  const groupOf = useMemo(() => {
    const out: Record<string, string> = {}
    for (const job of liveJobs) out[job.id] = 'live'
    const runs = runGroups(
      visible,
      item => (item.name.startsWith('upload-') ? 'upload' : item.tool ?? item.kind),
      runGapOf,
      item => storyByFile.get(item.name),
    )
    for (const [name, group] of runs) out[name] = storyByFile.has(name) ? group : `r:${group}`
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on liveKey
  }, [storyByFile, liveKey, visible])
  const rects = useMemo(() => layoutCanvas(ids, saved, ratios, groupOf), [ids, saved, ratios, groupOf])

  // O(1) lookups: the tile loop and the batch counts ask for these once per rect.
  const itemsByName = useMemo(() => new Map(visible.map(item => [item.name, item])), [visible])
  const liveById = useMemo(() => new Map(liveJobs.map(job => [job.id, job])), [liveJobs])
  /** The picked tiles, sorted once by what each selection button acts on. */
  const pickedGroups = useMemo(() => groupPicked(picked, itemsByName), [picked, itemsByName])

  return {
    onHistory, historyItems, historyCounts, visible, visibleNames, historyLeft, historyEmpty, historyListed,
    ownLive, upscaling, scanChoice, ids, rects, itemsByName, liveById, pickedGroups,
  }
}
