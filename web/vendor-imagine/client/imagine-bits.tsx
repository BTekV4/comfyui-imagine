/**
 * Small pieces the studio's page, its tiles and its viewer share: the
 * reduced-motion check, the running ellipsis, the quality badge and the
 * progress stage. Split out of ImaginePage.tsx on 2026-10-20; the clock
 * formats moved to `format.ts` on 2026-10-25.
 */

import { useEffect, useState } from 'react'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { qualityBadgeOf } from './imagine-settings.ts'
import css from './ImaginePage.module.css'
import { translate } from './locale-store.ts'

/**
 * Whether the viewer asked for less motion. The studio animates a rotating
 * headline for as long as the home view is open and a four-step ellipsis while
 * a job runs; neither carries information the still text does not.
 * @returns true when the reduced-motion preference is set.
 */
export function prefersReducedMotion(): boolean {
  if (typeof globalThis.matchMedia !== 'function') return false
  return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function GeneratingLabel() {
  const [step, setStep] = useState(0)
  useEffect(() => {
    // A settled ellipsis under reduced motion: the percentage next to it is
    // what actually reports progress.
    if (prefersReducedMotion()) { setStep(3); return }
    const timer = globalThis.setInterval(() => { setStep(current => (current + 1) % 4) }, 400)
    return () => { globalThis.clearInterval(timer) }
  }, [])
  return <span>{translate('imagine.jobRunningDots', { dots: '.'.repeat(step) })}</span>
}

export function QualityBadge({
  item,
}: {
  item: GalleryItem
}) {
  const label = qualityLabelOf(item)
  return label === undefined ? null : <span className={css.hd}>{label}</span>
}

/**
 * The quality a file is marked with («HD», «1080p», «4K»…), or undefined
 * when it has no size or is below HD. The board's tiles draw it their own way.
 */
export function qualityLabelOf(item: GalleryItem): string | undefined {
  if (item.width === undefined || item.height === undefined) return undefined
  const badge = qualityBadgeOf(item.width, item.height, item.kind)
  if (badge === undefined) return undefined
  return badge === 'HD' ? translate('imagine.hd') : badge === '4K' ? translate('imagine.q4k') : badge === '1440p' ? translate('imagine.q1440') : translate('imagine.q1080')
}

/** Pending-tile stage label keys, one per recognized ComfyUI node class. */
type ProgressStageKey = 'imagine.stageDenoise' | 'imagine.stageDecode' | 'imagine.stageEncode'

const PROGRESS_STAGES: Readonly<Record<string, ProgressStageKey>> = {
  KSampler: 'imagine.stageDenoise',
  KSamplerAdvanced: 'imagine.stageDenoise',
  SamplerCustomAdvanced: 'imagine.stageDenoise',
  VAEDecode: 'imagine.stageDecode',
  VAEUtils_VAEDecodeTiled: 'imagine.stageDecode',
  VAEEncode: 'imagine.stageEncode',
}

/** The pending-tile stage label for one executing node class, when known. */
export function progressStageLabel(nodeClass: string): ProgressStageKey | undefined {
  return PROGRESS_STAGES[nodeClass]
}

/**
 * The note that stands in for a track's picture. Every surface drew its own
 * `<span>♪</span>`; the class (usually composed from `imagine-shared`'s
 * `audioThumb`) still sizes it per place.
 * @param props.className - the place's class.
 * @returns the decorative glyph.
 */
export function AudioMark({ className }: { className: string | undefined }) {
  return <span className={className} aria-hidden="true">♪</span>
}
