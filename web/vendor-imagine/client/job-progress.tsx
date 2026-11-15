/**
 * How far each running job is, outside the page's state.
 *
 * The progress events (percentage, step, node, preview frame, how many scan
 * references are drawn) change about once a second while a job runs. They
 * used to be part of the queue's fingerprint, so every tick set the page's
 * `jobs` and re-ran the effects over every project. The queue is now set only
 * when something the board lays out changes, and the progress goes here: only
 * the pending tile, the upscale bar and the chat's row for the job read it.
 * @module job-progress
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { ImagineJobView as ImagineJob } from '../../../shared/imagine-types.ts'
import css from './JobProgress.module.css'

/** The part of a job that moves while it runs. */
export type JobProgressView = Pick<ImagineJob, 'progress' | 'scanProgress' | 'notice' | 'setupProgress'>

/** What changes when a job's progress does: the preview by its length and tail. */
function keyOf(job: JobProgressView): string {
  const progress = job.progress
  const preview = progress?.preview
  return [
    progress === undefined ? '-' : '+',
    progress?.percent, progress?.step, progress?.maxSteps, progress?.nodeClass, progress?.etaSeconds,
    preview === undefined ? '' : `${String(preview.length)}${preview.slice(-24)}`,
    job.scanProgress?.done, job.scanProgress?.total,
    // ComfyUI installing what the job needs: the step moves without the rest.
    job.notice, job.setupProgress?.stage,
  ].join(':')
}

const entries = new Map<string, { key: string; view: JobProgressView }>()
const listeners = new Map<string, Set<() => void>>()

/** Every job's progress, as the last queue read had it. */
export const jobProgress = {
  /**
   * Take the progress of some jobs; a job whose progress did not move keeps
   * its object, and only its readers are told.
   * @param jobs - jobs as the host reported them.
   * @param whole - the list is the whole queue: forget the jobs not in it.
   */
  take(jobs: readonly ImagineJob[], whole = false): void {
    const changed: string[] = []
    for (const job of jobs) {
      const key = keyOf(job)
      if (entries.get(job.id)?.key === key) continue
      entries.set(job.id, { key, view: { progress: job.progress, scanProgress: job.scanProgress, notice: job.notice, setupProgress: job.setupProgress } })
      changed.push(job.id)
    }
    if (whole) {
      const ids = new Set(jobs.map(job => job.id))
      for (const id of [...entries.keys()]) if (!ids.has(id)) entries.delete(id)
    }
    for (const id of changed) for (const listener of [...listeners.get(id) ?? []]) listener()
  },
  /**
   * @param id - the job.
   * @returns its progress, or undefined before the first report.
   */
  get(id: string): JobProgressView | undefined {
    return entries.get(id)?.view
  },
  subscribe(id: string, listener: () => void): () => void {
    let set = listeners.get(id)
    if (set === undefined) listeners.set(id, set = new Set())
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(id)
    }
  },
}

/**
 * One job's progress, re-rendering only when it moves.
 * @param id - the job.
 * @returns the progress, or undefined before the first report.
 */
export function useJobProgress(id: string): JobProgressView | undefined {
  const subscribe = useCallback((listener: () => void) => jobProgress.subscribe(id, listener), [id])
  const read = useCallback(() => jobProgress.get(id), [id])
  return useSyncExternalStore(subscribe, read, read)
}

/** A job's percentage, as its own word after the running label. */
export function Percent({ value }: { value: number | undefined }) {
  return value === undefined ? null : <span className={css.pct}>{` ${String(value)}%`}</span>
}

/** The thin bar under a running job. */
export function ProgressBar({ value }: { value: number | undefined }) {
  return (
    <span className={css.bar}>
      <span className={css.barFill} style={{ width: `${String(Math.min(100, value ?? 0))}%` }} />
    </span>
  )
}
