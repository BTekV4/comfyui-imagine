/**
 * The buttons under a multi-selection on the board: download, upscale, video,
 * publish, merge, delete and clear. Split out of ImaginePage.tsx (2026-10-25)
 * and memoized: they were a fresh JSX tree on every render of the page, which
 * re-rendered the board with them.
 * @module SelectionTools
 */

import { translate } from './locale-store.ts'
import { memo, type MouseEvent as ReactMouseEvent } from 'react'
import {
  IconCloseOutlineRegular, IconDownloadOutlineRegular, IconSparkleRegular, IconTrashOutlineRegular,
} from '../../shims/primitives/index.ts'
import { IconMerge } from './canvas-icons.tsx'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { upscaleEligible } from './imagine-settings.ts'
import css from './SelectionTools.module.css'

/** The picked tiles, sorted once by what each button can act on, in pick order. */
export interface PickedGroups {
  /** How many tiles are picked, running jobs included. */
  readonly count: number
  /** The picked files (a running job has none yet). */
  readonly items: readonly GalleryItem[]
  /** Files the upscale can still raise. */
  readonly upscalable: readonly GalleryItem[]
  /** Stills, the only kind the video graph takes as a first frame. */
  readonly stills: readonly GalleryItem[]
  /** Clips, which can be merged. */
  readonly clips: readonly GalleryItem[]
}

/**
 * Sort the picked tiles by what can be done with them.
 * @param picked - the picked tile ids, in pick order.
 * @param itemOf - the board's file for an id.
 * @returns the groups.
 */
export function groupPicked(picked: readonly string[], itemOf: ReadonlyMap<string, GalleryItem>): PickedGroups {
  const items = picked.map(id => itemOf.get(id)).filter((item): item is GalleryItem => item !== undefined)
  return {
    count: picked.length,
    items,
    upscalable: items.filter(item => upscaleEligible(item)),
    stills: items.filter(item => item.kind === 'image'),
    clips: items.filter(item => item.kind === 'video'),
  }
}

export interface SelectionToolsProps {
  readonly groups: PickedGroups
  /** A run is starting: the buttons that start one wait. */
  readonly busy: boolean
  readonly merging: boolean
  readonly onDownload: () => void
  /** Open the upscale menu over the button. */
  readonly onUpscale: (event: ReactMouseEvent<HTMLButtonElement>) => void
  readonly onVideo: () => void
  /** Absent when there is nowhere to publish (no Instagram plugin): no button. */
  readonly onPublish: (() => void) | undefined
  readonly onMerge: () => void
  readonly onDelete: () => void
  readonly onClear: () => void
}

export const SelectionTools = memo(function SelectionTools({
  groups, busy, merging, onDownload, onUpscale, onVideo, onPublish, onMerge, onDelete, onClear,
}: SelectionToolsProps) {
  const upscalable = groups.upscalable.length
  const stills = groups.stills.length
  const clips = groups.clips.length
  return (
    <>
      <button type="button" className={css.chipBtn} onClick={onDownload}>
        <IconDownloadOutlineRegular size={16} />
        <span>{translate('imagine.batchZip', { count: String(groups.count) })}</span>
      </button>
      {/*
        * Beside the download, not in a pill of its own at the foot of the
        * board: both act on the same selection, and the one that was parked in
        * a corner read as belonging to the screen rather than to the tiles. It
        * stays put and explains itself when nothing picked can be raised,
        * instead of vanishing and leaving the batch looking download-only.
        */}
      <button
        type="button"
        className={css.chipBtn}
        disabled={busy || upscalable === 0}
        title={upscalable === 0 ? translate('imagine.batchUpscaleNone') : undefined}
        onClick={onUpscale}
      >
        <IconSparkleRegular size={16} />
        <span>{translate('imagine.batchUpscale', { count: String(upscalable) })}</span>
      </button>
      <button
        type="button"
        className={css.chipBtn}
        disabled={busy || stills === 0}
        title={stills === 0 ? translate('imagine.batchVideoNone') : translate('imagine.batchVideoStage')}
        onClick={onVideo}
      >
        <IconSparkleRegular size={16} />
        <span>{translate('imagine.batchVideo', { count: String(stills) })}</span>
      </button>
      {onPublish !== undefined && stills > 1 && stills <= 10 && (
        <button type="button" className={css.chipBtn} onClick={onPublish}>
          <span>{translate('imagine.batchPublish', { count: stills })}</span>
        </button>
      )}
      {clips >= 2 && (
        <button
          type="button"
          className={css.chipBtn}
          disabled={merging || busy}
          title={translate('imagine.batchOrderTitle')}
          onClick={onMerge}
        >
          <IconMerge />
          <span>{merging ? translate('imagine.mergingClips') : translate('imagine.mergeClips', { count: clips })}</span>
        </button>
      )}
      <button type="button" className={css.chipBtn} data-danger disabled={busy} onClick={onDelete}>
        <IconTrashOutlineRegular size={16} />
        <span>{translate('imagine.batchDelete', { count: String(groups.count) })}</span>
      </button>
      <button type="button" className={css.batchClear} aria-label={translate('imagine.batchClear')} onClick={onClear}>
        <IconCloseOutlineRegular size={14} />
      </button>
    </>
  )
})
