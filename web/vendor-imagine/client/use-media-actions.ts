/**
 * What can be done to files, from whichever surface offers it — a tile's bar,
 * its right-click menu, the viewer, the selection bar, All media: delete,
 * like, download, duplicate, merge, stop, and placing a new file on the board.
 * Split out of ImaginePage.tsx (2026-11-07).
 * @module use-media-actions
 */

import { useEffect, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react'
import type { CanvasRect, ImagineProject } from '../../../shared/imagine-projects.ts'
import type { GalleryItem, ImagineAction, ImagineJobView as ImagineJob } from '../../../shared/imagine-types.ts'
import type { BoardHandle } from './Board.tsx'
import type { ComposerStore } from './composer-store.ts'
import {
  cancelImagineJob, deleteGalleryItem, duplicateGalleryItem, fetchLikes, fetchMediaZip, mediaUrlOf, mergeClips, saveLikes,
} from './gallery-api.ts'
import { noteFromError } from './imagine-messages.ts'
import type { ImagineMode } from './imagine-settings.ts'
import { translate } from './locale-store.ts'
import { messageOf } from './message-of.ts'
import { CLOSES_VIEWER, downloadUrl, type MediaActionKind } from './media-actions.tsx'
import type { Overlay } from './Overlays.tsx'
import type { ImaginePageProps } from './props.ts'
import type { PickedGroups } from './SelectionTools.tsx'
import { copyStill } from './TileMenu.tsx'
import type { RunOverride } from './use-runner.ts'

/** What the file actions read of the page, current on every render. */
export interface MediaActionsContext {
  readonly actions: ImaginePageProps['actions']
  readonly composer: ComposerStore
  readonly busy: string | undefined
  readonly setBusy: Dispatch<SetStateAction<string | undefined>>
  readonly setNote: (note: string | undefined) => void
  /** The open project, if any. */
  readonly current: ImagineProject | undefined
  /** The rail as last rendered, for a patch made after an await. */
  readonly projectsRef: MutableRefObject<readonly ImagineProject[]>
  readonly patch: (project: ImagineProject) => ImagineProject
  readonly addItems: (items: readonly GalleryItem[]) => void
  readonly setItems: Dispatch<SetStateAction<readonly GalleryItem[]>>
  readonly editJobs: (update: (current: readonly ImagineJob[]) => readonly ImagineJob[]) => void
  readonly setSelected: Dispatch<SetStateAction<GalleryItem | undefined>>
  readonly setMediaList: Dispatch<SetStateAction<readonly GalleryItem[] | undefined>>
  readonly setPicked: Dispatch<SetStateAction<readonly string[]>>
  readonly setOverlay: Dispatch<SetStateAction<Overlay | undefined>>
  readonly setPublishItem: Dispatch<SetStateAction<GalleryItem | undefined>>
  readonly setSource: (next: GalleryItem | undefined) => void
  readonly stageSource: (next: GalleryItem) => void
  readonly revealChat: () => void
  readonly changeMode: (next: ImagineMode) => void
  readonly run: (action: ImagineAction, from?: GalleryItem, over?: RunOverride) => Promise<ImagineProject | undefined>
  readonly pickedGroups: PickedGroups
  readonly boardApi: RefObject<BoardHandle | null>
  /** The laid-out tiles: a file waiting to be focused is tried again when they move. */
  readonly rects: readonly CanvasRect[]
}

export function useMediaActions(ctx: MediaActionsContext) {
  const {
    actions, composer, busy, setBusy, setNote, current, projectsRef, patch, addItems, setItems, editJobs,
    setSelected, setMediaList, setPicked, setOverlay, setPublishItem, setSource, stageSource, revealChat, changeMode,
    run, pickedGroups, boardApi, rects,
  } = ctx
  /** Files with a "Like", for All media's "Liked". */
  const [likes, setLikes] = useState<ReadonlySet<string>>(new Set())
  const [merging, setMerging] = useState(false)
  /** A file just put on the board, to centre and select once its tile exists. */
  const [pendingFocus, setPendingFocus] = useState<string | undefined>(undefined)

  useEffect(() => {
    void fetchLikes().then((names) => { setLikes(new Set(names)) }, () => undefined)
  }, [])

  /**
   * Delete files behind one confirmation, from any surface: a tile, the
   * board's selection, the Delete key, All media. A file the host refuses
   * stops the run, so the rest are still there to try again. Whatever was
   * deleted leaves every place that pointed at it.
   * @param targets - the files to delete.
   */
  const deleteItems = async (targets: readonly GalleryItem[]): Promise<void> => {
    const first = targets[0]
    if (first === undefined || busy !== undefined) return
    const question = targets.length === 1
      ? translate('imagine.confirmDelete')
      : translate('imagine.confirmDeleteMany', { count: String(targets.length) })
    if (!globalThis.confirm(question)) return
    setNote(undefined)
    setBusy(targets.length === 1 ? first.name : 'delete')
    const gone = new Set<string>()
    try {
      for (const item of targets) {
        await deleteGalleryItem(item.name)
        actions.regrid([item.name])
        gone.add(item.name)
      }
    } catch (error: unknown) {
      setNote(noteFromError(error))
    } finally {
      if (gone.size > 0) {
        setItems(currentItems => currentItems.filter(entry => !gone.has(entry.name)))
        setSelected(shown => (shown !== undefined && gone.has(shown.name) ? undefined : shown))
        setMediaList(list => list?.filter(entry => !gone.has(entry.name)))
        composer.set(state => (state.sources.some(entry => gone.has(entry.name))
          ? { sources: state.sources.filter(entry => !gone.has(entry.name)) }
          : {}))
        setPicked(chosen => (chosen.some(id => gone.has(id)) ? chosen.filter(id => !gone.has(id)) : chosen))
      }
      setBusy(undefined)
    }
  }

  /**
   * Stage every picked still in the composer as the starting images of a clip,
   * so the video controls and the prompt are chosen with the selection in
   * sight and sent once, for all of them. Files that are not stills are
   * skipped rather than refused.
   */
  const stageBatchVideo = (): void => {
    const targets = pickedGroups.stills
    if (targets.length === 0 || busy !== undefined) return
    composer.set({ note: undefined, sources: targets, mode: 'video' })
    setPicked([])
    revealChat()
  }

  /**
   * A file the canvas itself made (a trim, a merge, a frame): into the
   * gallery list, onto this project's board, centred and selected.
   */
  const placeOnBoard = (item: GalleryItem): void => {
    addItems([item])
    /*
     * The project as it is now, not as the render that made this closure saw
     * it: the callers usually awaited the host first (a duplicate, a merge, a
     * dialog's save), and lines or files added meanwhile were written back
     * out of existence.
     */
    const id = current?.id
    const latest = id === undefined ? undefined : projectsRef.current.find(project => project.id === id)
    if (latest !== undefined && !latest.itemNames.includes(item.name)) {
      // A free spot, not wherever an old position for this name says.
      actions.regrid([item.name])
      patch({ ...latest, itemNames: [...latest.itemNames, item.name] })
    }
    setPendingFocus(item.name)
  }
  useEffect(() => {
    if (pendingFocus === undefined) return
    if (boardApi.current?.focus(pendingFocus) !== true) return
    const name = pendingFocus
    setPendingFocus(undefined)
    // Once more when the board has settled: arriving from another view, the
    // first pass measured a board and a layout still being built, and the
    // tile landed half off screen.
    window.setTimeout(() => { boardApi.current?.focus(name) }, 450)
  }, [pendingFocus, rects])

  /**
   * The heart on one or several files. Drawn at once and sent after; a POST
   * that fails puts the hearts back as they were.
   */
  const likeMany = (names: readonly string[], liked: boolean): void => {
    // Only the names this call really changed are put back on a failure, on
    // the hearts as they are then: restoring the whole set of this render
    // also undid a second toggle made while the POST was out.
    const changed = names.filter(name => likes.has(name) !== liked)
    const flip = (on: boolean) => (now: ReadonlySet<string>): ReadonlySet<string> => {
      const next = new Set(now)
      for (const name of changed) { if (on) next.add(name); else next.delete(name) }
      return next
    }
    setLikes(flip(liked))
    void saveLikes(names, liked)
      .then((stored) => { if (stored !== undefined) setLikes(new Set(stored)) })
      .catch(() => { setLikes(flip(!liked)) })
  }
  /**
   * Save files: one straight from its address, several as one archive the
   * host builds. The object URL is revoked a minute later: revoked at once,
   * the click it was handed to could still be reading it.
   */
  const downloadMany = async (chosen: readonly GalleryItem[]): Promise<void> => {
    if (chosen.length === 0) return
    try {
      if (chosen.length === 1 && chosen[0] !== undefined) {
        downloadUrl(mediaUrlOf(chosen[0].name), chosen[0].name)
        return
      }
      const { blob, filename } = await fetchMediaZip(chosen.map(item => item.name))
      const url = URL.createObjectURL(blob)
      downloadUrl(url, filename)
      window.setTimeout(() => { URL.revokeObjectURL(url) }, 60_000)
    } catch (error: unknown) {
      setNote(noteFromError(error))
    }
  }
  /** A second copy of a photo beside it, to work on without losing the first. */
  const duplicateStill = async (item: GalleryItem): Promise<void> => {
    setNote(undefined)
    try {
      placeOnBoard(await duplicateGalleryItem(item.name))
    } catch (error: unknown) {
      setNote(noteFromError(error))
    }
  }
  const mergeSelection = async (): Promise<void> => {
    const clips = pickedGroups.clips
    if (clips.length < 2) return
    setMerging(true)
    setNote(undefined)
    try {
      placeOnBoard(await mergeClips(clips.map(clip => clip.name)))
    } catch (error: unknown) {
      setNote(noteFromError(error))
    } finally {
      setMerging(false)
    }
  }

  /**
   * Stop a live job. The queue is served one prompt at a time, so a start the
   * user regrets otherwise blocks everything behind it until it finishes.
   */
  const stopJob = async (id: string): Promise<void> => {
    try {
      await cancelImagineJob(id)
      editJobs(currentJobs => currentJobs.map(job => (job.id === id ? { ...job, status: 'cancelled' } : job)))
    } catch (error: unknown) {
      setNote(noteFromError(error))
    }
  }

  /**
   * Run one of a file's actions, from whichever surface offered it: the
   * tile's bar, its right-click menu or the viewer. One handler, so the three
   * do the same thing; the viewer only steps aside first for the actions that
   * hand the file to the composer or to a dialog.
   * @param kind - the action.
   * @param item - the file.
   * @param from - the surface it was picked on.
   * @param anchor - where a card or menu opens: the tile, or the button.
   */
  const actOn = (kind: MediaActionKind, item: GalleryItem, from: 'tile' | 'menu' | 'viewer', anchor?: DOMRect): void => {
    if (from === 'viewer' && CLOSES_VIEWER.has(kind)) setSelected(undefined)
    switch (kind) {
      case 'details':
        if (anchor !== undefined) setOverlay({ kind: 'details', item, anchor })
        return
      case 'open':
        setSelected(item)
        setSource(item)
        return
      case 'remix':
        stageSource(item)
        composer.set({ mode: 'image' })
        return
      case 'video':
      case 'extend':
        stageSource(item)
        composer.set({ mode: 'video' })
        void run(kind, item)
        return
      case 'bg':
        void run('bg', item)
        return
      case 'voice':
        void run('voice', item, { prompt: translate('imagine.changeVoice') })
        return
      case 'region':
      case 'crop':
      case 'erase':
      case 'trim':
      case 'frames':
        setOverlay({ kind, item })
        return
      case 'duplicate': void duplicateStill(item); return
      case 'copy':
        void copyStill(mediaUrlOf(item.name)).then(
          () => { setNote(translate('imagine.imageCopied')) },
          (error: unknown) => { setNote(messageOf(error)) },
        )
        return
      case 'upscale':
        if (anchor !== undefined) setOverlay({ kind: 'upscale', items: [item], anchor, batch: false })
        return
      case 'cover':
        if (current !== undefined) patch({ ...current, cover: item.name })
        return
      case 'like': likeMany([item.name], !likes.has(item.name)); return
      case 'download': downloadUrl(mediaUrlOf(item.name), item.name); return
      case 'publish': setPublishItem(item); return
      case 'delete': void deleteItems([item]); return
    }
  }
  /**
   * Use a frame the extractor just saved, as the button under it says: an
   * edit, a clip or a restyle of it, the same as those actions on a tile. With
   * no action named it is staged in the composer.
   */
  const takeFrame = (item: GalleryItem, card?: 'remix' | 'video' | 'style' | 'bg'): void => {
    if (card === 'remix' || card === 'video' || card === 'bg') {
      actOn(card, item, 'tile')
      return
    }
    stageSource(item)
    if (card === 'style') changeMode('style')
  }

  return {
    likes, merging, setPendingFocus, deleteItems, stageBatchVideo, placeOnBoard, likeMany, downloadMany,
    mergeSelection, stopJob, actOn, takeFrame,
  }
}
