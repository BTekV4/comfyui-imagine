/**
 * The studio's link with the host: the inventory, the job queue and the
 * shared studio read, merged and saved; the ticks that keep them fresh; the
 * finished jobs folded into their projects; and the Instagram queue the rail
 * counts. Split out of ImaginePage.tsx (2026-10-25).
 *
 * One tick for the queue, through `useVisibleInterval` (it sleeps with the
 * tab hidden and catches up at once when it shows again): every second while
 * a job this board owns is live or a read is owed, every three seconds
 * otherwise, and backing off up to thirty seconds while the host keeps
 * failing. A tick never starts while the last is still out. The stages of a music video are adopted on that same tick — they
 * used to have a fetch of the queue of their own every three seconds.
 * @module use-studio-sync
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { CanvasRect, ImagineProject } from '../../../shared/imagine-projects.ts'
import type { GalleryItem, ImagineJobView as ImagineJob } from '../../../shared/imagine-types.ts'
import {
  acceptGallery, fetchGallery, fetchImagineJobs, fetchImagineStudio, fetchSocialPostsIfChanged, jobIsLive, saveImagineStudio,
  type ImagineStudio, type SocialPost,
} from './gallery-api.ts'
import {
  absorbJobFiles, capTombstones, ensureHistoryProject, followRenames, mergeProjects, mergeTombstones,
  purgeEmptyProjects, rememberJob, sameList, sameRect, stripRemoved, upscaleReplacements, type ImagineTombstones,
} from './imagine-projects.ts'
import { jobDoneText, jobsFingerprint, noticeText } from './imagine-messages.ts'
import { jobProgress } from './job-progress.tsx'
import type { ImaginePageProps } from './props.ts'
import type { ProjectNaming } from './use-project-naming.ts'
import { useVisibleInterval } from './use-visible-interval.ts'
import { translate } from './locale-store.ts'

/**
 * What the host is known to hold, as of the last studio read and the saves
 * that succeeded since: a save sends only what differs from it.
 */
interface HostCopy {
  /** Each project the host holds, as an object whose content equals the host's. */
  readonly projects: Map<string, ImagineProject>
  readonly placed: Record<string, CanvasRect>
  deleted: ImagineTombstones
}

/**
 * Whether two JSON-shaped values hold the same content, whatever the order of
 * their keys; a key set to `undefined` counts as absent, as it does on the wire.
 * @param a - one value.
 * @param b - the other.
 */
function sameContent(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => sameContent(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left).filter(key => left[key] !== undefined)
  if (keys.length !== Object.keys(right).filter(key => right[key] !== undefined).length) return false
  return keys.every(key => sameContent(left[key], right[key]))
}

/** What the sync reads of the page, current on every render. */
export interface StudioSyncContext {
  /** Whether the Instagram plugin is there: its queue is read only then. */
  readonly social: boolean
  readonly projects: readonly ImagineProject[]
  /** The rail as last rendered: the merge and the adoption read it. */
  readonly projectsRef: MutableRefObject<readonly ImagineProject[]>
  /** The tiles' saved positions. */
  readonly placed: ImagineStudio['placed']
  readonly deleted: ImagineTombstones
  readonly actions: ImaginePageProps['actions']
  readonly naming: ProjectNaming
  readonly patch: (project: ImagineProject) => void
  /** The note under the composer: the stage a music video is on. */
  readonly setNote: (note: string | undefined) => void
  /**
   * A source an upscale replaced, gone from the board: everything that
   * pointed at it (the viewer, the staging, the selection) follows it.
   */
  readonly onRetire: (from: string, to: string, replacement: GalleryItem) => void
}

export function useStudioSync(ctx: StudioSyncContext) {
  const { social, projects, projectsRef, placed, deleted, actions } = ctx
  const [items, setItems] = useState<readonly GalleryItem[]>([])
  /** Every file of the inventory by name: the one lookup of the studio. */
  const allByName = useMemo(() => new Map(items.map(item => [item.name, item])), [items])
  const [jobs, setJobs] = useState<readonly ImagineJob[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [syncPending, setSyncPending] = useState(false)
  /**
   * Reads of the host that failed in a row, capped at 5. While it is above
   * zero the queue tick backs off (2 s, 4 s … 30 s) instead of running at the
   * fast rate: a failure also marks a read as owed (`syncPending`), and that
   * alone used to put an unreachable host, or a proxy answering 502, on one
   * request per second per open tab, for as long as the tab stayed open.
   */
  const [failures, setFailures] = useState(0)
  const failuresRef = useRef(0)
  const hostAnswered = (): void => {
    if (failuresRef.current === 0) return
    failuresRef.current = 0
    setFailures(0)
  }
  const hostFailed = (): void => {
    failuresRef.current = Math.min(failuresRef.current + 1, 5)
    setFailures(failuresRef.current)
  }
  /** A rejected PUT, kept on screen until one succeeds: see `persist`. */
  const [saveFailed, setSaveFailed] = useState(false)
  const [socialPosts, setSocialPosts] = useState<readonly SocialPost[]>([])

  /** The latest context, for the reads that run outside a render. */
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const itemsRef = useRef(items)
  itemsRef.current = items
  const deletedRef = useRef(deleted)
  deletedRef.current = deleted

  /** Jobs already folded into the gallery by a successful reload. */
  const settledRef = useRef(-1)
  /** The job queue last set, as a fingerprint, so an unchanged tick sets nothing. */
  const jobsSeenRef = useRef<string | undefined>(undefined)
  /** Live jobs of no known project that already cost one studio read. */
  const lookedUpJobsRef = useRef(new Set<string>())
  /*
   * A save is only ever allowed to describe a rail we actually read back. The
   * PUT replaces the shared store, so saving before the first successful load
   * writes "the projects I know about" — which, on a browser with nothing
   * cached and a GET that failed, is whatever this session just created. That
   * wiped every project on disk.
   */
  const loadedRef = useRef(false)
  /** The empty-project purge runs once per page life, never on its own output. */
  const purgedRef = useRef(false)
  /**
   * Tiles whose saved position this session dropped, until a save carries the
   * removal. The studio PUT merges `placed` key by key, so an omitted tile
   * means "nothing to say", never "forget it": a regrid has to name them.
   */
  const unplacedRef = useRef<readonly string[]>([])
  /**
   * What the host holds, so a save carries only the projects, tiles and
   * tombstones that differ from it: every tile drop and chat line used to PUT
   * the whole studio (~1.4 MB). The store keeps an unchanged project's
   * reference, so most projects are skipped on identity alone.
   */
  const hostRef = useRef<HostCopy>({ projects: new Map(), placed: {}, deleted: {} })
  /** Sources already retired by their upscale, so it happens once each. */
  const retiredRef = useRef(new Set<string>())
  /**
   * A full read is owed: the last one failed, or its inventory was held back
   * (see acceptGallery). The live tick only re-reads the gallery when the job
   * count moves, so without this a board emptied by a bad read stayed empty
   * until the page was reloaded.
   */
  const galleryOwedRef = useRef(false)
  /** Empty inventories held back in a row; see acceptGallery. */
  const emptyStreakRef = useRef(0)
  /*
   * The music video being built, and the project that started it. The
   * project is remembered here rather than read off the rail at each tick:
   * the chain runs for half an hour, and adopting its waves into whichever
   * project happened to be open put one video's song and shots into another
   * video's board.
   */
  const clipChainRef = useRef<{ id: string; projectId: string } | undefined>(undefined)

  /** Put files at the head of the inventory, replacing any of the same name. */
  const addItems = useCallback((added: readonly GalleryItem[]): void => {
    if (added.length === 0) return
    setItems(current => [...added, ...current.filter(entry => !added.some(item => item.name === entry.name))])
  }, [])

  /** A change made here to the queue: the next tick must set what it reads. */
  const editJobs = useCallback((update: (current: readonly ImagineJob[]) => readonly ImagineJob[]): void => {
    jobsSeenRef.current = undefined
    setJobs(update)
  }, [])

  /**
   * Write the shared studio, but never before a load has succeeded, and never
   * silently: a rejected PUT used to be swallowed, so the rail kept showing
   * work the server had refused and the next reload made it vanish.
   *
   * Only what the host does not hold yet is sent: the projects that differ
   * from its copy, the tiles added or moved, and every tombstone. The host
   * keeps whatever a payload leaves out (`saveImagineStore`), so a project
   * that is not sent is never dropped; a deleted one goes as its tombstone,
   * as it always did.
   * @param studio - the rail to persist, whole: the difference is worked out here.
   */
  const persist = async (studio: ImagineStudio): Promise<void> => {
    if (!loadedRef.current) return
    const host = hostRef.current
    const sent = studio.unplaced ?? []
    const projects = studio.projects.filter((project) => {
      const held = host.projects.get(project.id)
      if (held === project) return false
      // The host's own copy after a read is another object with, often, the
      // same content: compared once, then remembered by identity.
      if (held !== undefined && sameContent(held, project)) {
        host.projects.set(project.id, project)
        return false
      }
      return true
    })
    const placed: Record<string, CanvasRect> = {}
    for (const [id, rect] of Object.entries(studio.placed)) {
      if (!sameRect(host.placed[id], rect)) placed[id] = rect
    }
    const deleted = studio.deleted ?? {}
    const newTombstone = Object.entries(deleted).some(([id, at]) => host.deleted[id] !== at)
    if (projects.length === 0 && Object.keys(placed).length === 0 && sent.length === 0 && !newTombstone) return
    try {
      await saveImagineStudio({ projects, placed, deleted, unplaced: sent })
      setSaveFailed(false)
      // What the host holds now, read again: a studio read may have replaced
      // the copy while the request was out.
      const now = hostRef.current
      for (const project of projects) now.projects.set(project.id, project)
      for (const [id, rect] of Object.entries(placed)) now.placed[id] = rect
      // A tile both placed and unplaced is re-placed: the host keeps the rect.
      for (const id of sent) if (placed[id] === undefined) Reflect.deleteProperty(now.placed, id)
      now.deleted = { ...now.deleted, ...deleted }
      // Only the ids this request actually carried are forgotten. A regrid
      // that happened while it was in flight is still owed to the server, and
      // clearing the whole list here would strand it.
      if (sent.length > 0) {
        unplacedRef.current = unplacedRef.current.filter(id => !sent.includes(id))
      }
    } catch {
      // Nothing is recorded as held, so the next save carries this payload's
      // changes again along with its own.
      setSaveFailed(true)
    }
  }

  /**
   * Take a queue just read: its progress to `job-progress`, the rest to the
   * page only when something the page reads of it changed. Every tick used to
   * hand React a new array, and the whole studio rendered again each second
   * while a job ran.
   */
  const takeJobs = (next: readonly ImagineJob[]): void => {
    jobProgress.take(next, true)
    const seen = jobsFingerprint(next)
    if (seen !== jobsSeenRef.current) {
      jobsSeenRef.current = seen
      setJobs(next)
    }
  }

  const reloadOnce = async (): Promise<void> => {
    const { naming } = ctxRef.current
    setStatus('loading')
    try {
      const [nextItems, nextJobs, studio] = await Promise.all([
        fetchGallery(),
        fetchImagineJobs(),
        fetchImagineStudio(),
      ])
      /*
       * Each of the two may answer 304: the host sends its body only when it
       * changed. A held inventory keeps this browser's own copy and counts as
       * one more empty read, since a listing that never changes is still the
       * listing the streak is about.
       */
      const verdict = acceptGallery(itemsRef.current.length, nextItems ?? [], emptyStreakRef.current)
      emptyStreakRef.current = verdict.emptyStreak
      galleryOwedRef.current = nextItems === undefined || !verdict.accept
      if (nextItems !== undefined && verdict.accept) setItems(nextItems)
      takeJobs(nextJobs)
      // The studio came back: from here a save describes the shared rail and
      // not just this session's idea of it.
      loadedRef.current = true
      settledRef.current = nextJobs.filter(job => !jobIsLive(job)).length
      /*
       * A 304 on the studio means this browser's rail is the host's: there is
       * nothing to merge, and the rest of the pass (purge, naming, writes) is
       * the work of a rail that just arrived.
       */
      hostAnswered()
      if (studio === undefined) {
        setStatus('idle')
        setSyncPending(galleryOwedRef.current)
        return
      }
      // This is what the host holds now: the base the next save is measured
      // against.
      hostRef.current = {
        projects: new Map(studio.projects.map(project => [project.id, project])),
        placed: { ...studio.placed },
        deleted: { ...studio.deleted },
      }
      // Tombstones travel with the projects and win over both copies, so a
      // delete survives a merge with a stale rail from another browser. They
      // are capped by count as the host caps them, never expired by age:
      // forgetting an old one would let that stale rail bring it back.
      const tombstones = capTombstones(mergeTombstones(deletedRef.current, studio.deleted ?? {}))
      actions.setDeleted(tombstones)
      // Removals win over both copies too: the richer copy of a project is
      // the one that still lists a file somebody took out of it.
      const merged = followRenames(
        stripRemoved(mergeProjects(projectsRef.current, studio.projects, tombstones), studio.removed),
        studio.renamed,
      )
      // An unchanged rail is not set again: a new array would only start
      // another save of the same projects.
      if (merged.length > 0 && !sameList(merged, projectsRef.current)) actions.setProjects(merged)
      actions.placeMany(Object.values(studio.placed))
      // Forget the projects a home card left behind without ever generating
      // anything. Once per opening, on the merged rail we just built: driving
      // this from an effect that watches `projects` would feed its own output
      // back in, which is how the React #185 loop happened before.
      if (!purgedRef.current) {
        purgedRef.current = true
        const purge = purgeEmptyProjects(merged, Date.now())
        const ids = Object.keys(purge.deleted)
        if (ids.length > 0) {
          actions.purgeProjects(ids, Date.now())
          void persist({
            projects: purge.kept,
            placed: ctxRef.current.placed,
            deleted: { ...tombstones, ...purge.deleted },
          })
        }
      }
      // Projects still on a system-minted name that hold content are named
      // from it: the pass runs on every reload, but the per-page ref set lets
      // each project through once, and a settled title stops the asking.
      for (const project of merged) {
        if (!naming.isNamingCandidate(project)) continue
        const source = naming.namingSourceOf(project)
        if (source !== undefined) naming.titleIfNeeded(project, source)
      }
      setStatus('idle')
      // A held-back inventory keeps the fast tick asking.
      setSyncPending(galleryOwedRef.current)
    } catch {
      galleryOwedRef.current = true
      setStatus('error')
      // Ask the live tick to try again instead of leaving the canvas behind;
      // it does so on a backed-off period while the host keeps failing.
      setSyncPending(true)
      hostFailed()
    }
  }
  const reloadOnceRef = useRef(reloadOnce)
  reloadOnceRef.current = reloadOnce

  /** The reload in flight, and whether another was asked for meanwhile. */
  const reloadingRef = useRef<Promise<void> | undefined>(undefined)
  const reloadAgainRef = useRef(false)
  /**
   * One full read at a time. The one-second tick used to start a reload while
   * the last was still out, and the older answer could land after the newer
   * one and put the board back. A reload asked for meanwhile runs once more
   * when the current one ends, with the render's newest closure.
   */
  const reload = useCallback((): Promise<void> => {
    if (reloadingRef.current !== undefined) {
      reloadAgainRef.current = true
      return reloadingRef.current
    }
    const running = (async () => {
      try {
        await reloadOnceRef.current()
      } finally {
        reloadingRef.current = undefined
      }
      if (reloadAgainRef.current) {
        reloadAgainRef.current = false
        await reload()
      }
    })()
    reloadingRef.current = running
    return running
  }, [])

  /*
   * Adopt every stage of a music video into its project as it appears.
   *
   * The host queues the montage itself, minutes after the request answered, so
   * those clips exist in the queue and belong to nobody: the canvas would not
   * show them, and the fast tick — which only runs while a job the project
   * owns is live — would stop between the waves, leaving the studio looking
   * finished while eleven photos were still to render.
   */
  const adoptClipChain = (all: readonly ImagineJob[]): void => {
    const chain = clipChainRef.current
    if (chain === undefined) return
    const mine = all.filter(job => job.clipId === chain.id)
    if (mine.length === 0) return
    const { patch, setNote } = ctxRef.current
    const project = projectsRef.current.find(entry => entry.id === chain.projectId)
    if (project !== undefined) {
      let next = project
      for (const stage of mine) next = rememberJob(next, stage.id)
      if (next !== project) patch(next)
    }
    /*
     * Say which stage it is on. A music video is twenty minutes of work in
     * three waves, and between them the studio showed a finished-looking
     * board: the photos land, then nothing visible happens while the song is
     * written and sung, then the shots start.
     */
    const shots = mine.filter(job => job.storyId !== undefined)
    if (shots.length > 0) {
      const done = shots.filter(job => !jobIsLive(job)).length
      setNote(translate('imagine.clipStageMontage', {
        done: String(Math.min(done + 1, shots.length)),
        total: String(shots.length),
      }))
    }
    // The montage is the last wave: once it is queued and nothing is live,
    // there is nothing left to adopt.
    if (shots.length > 0 && !mine.some(job => jobIsLive(job))) clipChainRef.current = undefined
  }

  /**
   * Live tick: only the job queue carries progress and preview frames, so the
   * whole gallery is not re-read once a second. When a job settles, one full
   * reload brings its file in. settledRef moves only on a reload that
   * succeeded, so a failed one is retried at the next tick instead of losing
   * the finished file.
   */
  const reloadJobs = async (): Promise<void> => {
    try {
      const next = await fetchImagineJobs()
      takeJobs(next)
      adoptClipChain(next)
      /*
       * A job of another session — the assistant, another device, this same
       * tab's queue before a restart — lives in its project on the host. Only
       * a studio read tells the board it is ours: a live one gets its tile and
       * its preview, a finished one gets its file into the project the host
       * filed it in. Once per job, so work of the other sessions does not
       * re-read a tick.
       */
      // Every known job id once per tick, rather than a scan of every
      // project's list for every job in the queue.
      const known = new Set(projectsRef.current.flatMap(project => project.jobIds))
      const unknown = next.filter(job => (jobIsLive(job) || job.status === 'done')
        && !lookedUpJobsRef.current.has(job.id)
        && !known.has(job.id))
      for (const job of unknown) lookedUpJobsRef.current.add(job.id)
      if (galleryOwedRef.current || unknown.length > 0
        || next.filter(job => !jobIsLive(job)).length !== settledRef.current) {
        // The full read says itself whether the host answered.
        await reload()
      } else {
        setStatus('idle')
        hostAnswered()
      }
    } catch {
      // Keep the last snapshot: a dropped tick must not blank the canvas.
      setSyncPending(true)
      hostFailed()
    }
  }

  /*
   * Poll fast only while a job this client could show is alive. The queue is
   * shared, so an idle tab used to tick once a second for work it filters out
   * of every board anyway. The slow tick is what finds a job the host queued
   * and adopted on its own — the montage of a music video, a redo asked for
   * from another device — which belongs to no project this browser knows
   * until the studio is read again.
   */
  const ownedJobIds = useMemo(() => new Set(projects.flatMap(project => project.jobIds)), [projects])
  const live = jobs.some(job => jobIsLive(job) && ownedJobIds.has(job.id))
  /*
   * The promise is handed to the interval, so a tick never starts while the
   * last one is still out (a slow host used to get two queue reads at once).
   */
  const pollMs = failures > 0 ? Math.min(1000 * 2 ** failures, 30_000) : live || syncPending ? 1000 : 3000
  useVisibleInterval(reloadJobs, pollMs)
  useEffect(() => { void reload() }, [reload])

  /*
   * The publication queue is reloaded on a timer, not only after an edit: the
   * scheduler publishes on the host's clock, so a post can change state with
   * nobody touching the page.
   */
  const reloadPosts = useCallback(async (): Promise<void> => {
    if (!social) return
    await fetchSocialPostsIfChanged()
      .then((list) => {
        // A 304: the host says nothing changed.
        if (list === undefined) return
        setSocialPosts(list)
      })
      .catch(() => { /* the rail simply keeps the list it has */ })
  }, [social])
  useEffect(() => { void reloadPosts() }, [reloadPosts])
  useVisibleInterval(reloadPosts, social ? 20_000 : null)

  // The History is always on the rail; its board is the inventory, filtered.
  useEffect(() => {
    const next = ensureHistoryProject(projects, translate('imagine.history'))
    if (next !== projects) actions.setProjects(next)
  }, [projects, actions])

  // The shared studio, saved 400 ms after the last change of what it holds;
  // `persist` sends only the part the host does not hold.
  useEffect(() => {
    if (projects.length === 0) return
    const timer = globalThis.setTimeout(() => {
      void persist({ projects, placed, deleted, unplaced: unplacedRef.current })
    }, 400)
    return () => { globalThis.clearTimeout(timer) }
  }, [projects, placed, deleted])

  // Finished jobs into the projects that started them, with their lines.
  const upscaleReplaces = useMemo(() => upscaleReplacements(jobs), [jobs])
  /*
   * The project records already folded against this queue. A change of
   * `projects` alone (a chat line, a tile, this effect's own write) used to
   * map every project against every job; only the records that changed are
   * new objects, so only those are folded again. A new queue starts the set
   * over.
   */
  const absorbedRef = useRef<{
    jobs: readonly ImagineJob[]
    done: WeakSet<ImagineProject>
  } | undefined>(undefined)
  useEffect(() => {
    if (jobs.length === 0) return
    let seen = absorbedRef.current
    if (seen === undefined || seen.jobs !== jobs) {
      seen = { jobs, done: new WeakSet() }
      absorbedRef.current = seen
    }
    const { done } = seen
    // `upscaleReplaces` is computed once here, not once per project inside the
    // map: it scans every job.
    const next = projects.map(project => (done.has(project) ? project : absorbJobFiles(
      project,
      jobs,
      job => jobDoneText(job),
      key => noticeText(key),
      upscaleReplaces,
    )))
    for (const project of next) done.add(project)
    if (next.some((project, index) => project !== projects[index])) actions.setProjects(next)
  }, [jobs, projects, actions, upscaleReplaces])

  /*
   * An upscale replaces its source rather than sitting next to it: the project
   * lists swap the name (absorbJobFiles) and the canvas spot is inherited. The
   * original file is KEPT — it leaves this project's canvas but stays in the
   * gallery, so it is still there under History. Guarded by the ref so the
   * swap runs once per source per session; after a reload it re-runs and
   * inherit() is a no-op, the spot having already moved.
   */
  useEffect(() => {
    for (const [from, to] of Object.entries(upscaleReplaces)) {
      if (retiredRef.current.has(from)) continue
      if (!allByName.has(from)) continue
      // The upscaled file has to actually be there, or the canvas would hand
      // the source's spot to a name nothing can render.
      const replacement = allByName.get(to)
      if (replacement === undefined) continue
      retiredRef.current.add(from)
      actions.inherit(from, to)
      ctxRef.current.onRetire(from, to, replacement)
    }
  }, [upscaleReplaces, allByName, actions])

  return {
    items, allByName, addItems, setItems, jobs, editJobs, status, saveFailed,
    reload, reloadJobs, persist, unplacedRef, socialPosts, reloadPosts,
    /** Follow a music video's stages from here on, into the project that asked for it. */
    startClipChain: (id: string, projectId: string): void => { clipChainRef.current = { id, projectId } },
  }
}
