/**
 * The menu the Upscale buttons open: the steps the file can go to, each with
 * its exact size, instead of starting a run at a size the studio picked.
 * One file shows its own steps; a selection shows the steps for its stills
 * (its clips go to the largest clip step that grows them).
 */
import { translate } from './locale-store.ts'
import { useEffect, useRef } from 'react'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { upscaleChoicesOf, type UpscaleChoice } from './upscale-choices.ts'
import { useDismiss } from './use-dismiss.ts'
import css from './UpscaleMenu.module.css'

export interface UpscaleMenuProps {
  readonly items: readonly GalleryItem[]
  /** The button the menu belongs to, in viewport coordinates. */
  readonly anchor: DOMRect
  readonly onPick: (to: { image?: number; video?: number }) => void
  readonly onClose: () => void
}

const MENU_WIDTH = 260

/** The steps any of the files can go to, one per short side, smallest first. */
function mergedChoices(files: readonly GalleryItem[]): readonly UpscaleChoice[] {
  return [...new Map(files.flatMap(item => upscaleChoicesOf(item)).map(choice => [choice.short, choice])).values()].sort((a, b) => a.short - b.short)
}

export function UpscaleMenu({ items, anchor, onPick, onClose }: UpscaleMenuProps) {
  const box = useRef<HTMLDivElement>(null)
  useDismiss(box, onClose)
  useEffect(() => { box.current?.querySelector('button')?.focus() }, [])

  const stills = items.filter(item => item.kind === 'image')
  const clips = items.filter(item => item.kind === 'video')
  const single = items.length === 1 ? items[0] : undefined
  // For a selection: every step at least one file can grow to, sized on the first.
  const stillChoices = single !== undefined ? (single.kind === 'image' ? upscaleChoicesOf(single) : []) : mergedChoices(stills)
  const clipChoices = single !== undefined ? (single.kind === 'video' ? upscaleChoicesOf(single) : []) : mergedChoices(clips)
  const bestClip = clipChoices[clipChoices.length - 1]?.short

  const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - MENU_WIDTH / 2), window.innerWidth - MENU_WIDTH - 8)
  const below = anchor.bottom + 8
  const top = below + 240 > window.innerHeight ? Math.max(8, anchor.top - 248) : below

  const row = (choice: UpscaleChoice, pick: () => void) => (
    <button key={choice.short} type="button" role="menuitem" className={css.choice} onClick={pick}>
      <span className={css.label}>{choice.label}</span>
      <span className={css.size}>{choice.size}{single !== undefined && choice.factor > 2.05 ? ` · ×${choice.factor.toFixed(1)}` : ''}</span>
    </button>
  )

  return (
    <div ref={box} className={css.menu} role="menu" aria-label={translate('imagine.upscaleResolution')} style={{ left, top, width: MENU_WIDTH }}>
      <p className={css.head}>
        {single !== undefined ? translate('imagine.upscaleTo') : translate('imagine.upscaleFilesTo', { count: items.length })}
      </p>
      {stillChoices.length > 0 && single === undefined && clips.length > 0 && <p className={css.group}>{translate('imagine.photos')}</p>}
      {stillChoices.map(choice => row(choice, () => { onPick({ image: choice.short, ...bestClip === undefined ? {} : { video: bestClip } }) }))}
      {clipChoices.length > 0 && single === undefined && stills.length > 0 && <p className={css.group}>{translate('imagine.clipsAllTo', { size: clipChoices[clipChoices.length - 1]?.label ?? '' })}</p>}
      {(single !== undefined || stills.length === 0) && clipChoices.map(choice => row(choice, () => { onPick({ video: choice.short }) }))}
      {stillChoices.length === 0 && clipChoices.length === 0 && (
        <p className={css.none}>{single?.kind === 'video' ? translate('imagine.upscale1080') : translate('imagine.upscaleMax')}</p>
      )}
      {single !== undefined && stillChoices.some(choice => choice.factor > 2.05) && (
        <p className={css.note}>{translate('imagine.upscaleBeyond')}</p>
      )}
    </div>
  )
}
