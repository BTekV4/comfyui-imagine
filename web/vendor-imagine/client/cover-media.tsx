/**
 * An action's cover, drawn the same way everywhere.
 *
 * Home and the action panel mount THIS component: the precedence lives in
 * `coverChoiceOf` (`cover-plan.ts`), and as long as both surfaces go through
 * here they can no longer show two different covers for the same action
 * (4-11-2026: card with the repo's clip, panel with the user's image).
 * @module cover-media
 */

import { prefersReducedMotion } from './imagine-bits.tsx'
import { coverChoiceOf } from './cover-plan.ts'
import { useCoverInfos } from './cover-kind.ts'

/** Set by Vite at build time (`vite.config.ts`); absent outside a build. */
declare const __COVER_VERSION__: string | undefined

/**
 * The repo's covers stay cached for a day (`server/src/static.ts`): without a
 * new address a deploy that changed a cover, or a browser that had cached a
 * wrong answer for it (the public copy before its covers, 2026-11-15, which
 * not even Ctrl+Shift+R cleared), kept showing the old one.
 */
const COVER_VERSION = typeof __COVER_VERSION__ === 'string' ? __COVER_VERSION__ : ''

/**
 * The address with the build's version, for the repo's files under `/imagine/`.
 * @param src - a cover address.
 * @returns the same address, with `v=<build>` when it is a repo cover.
 */
function versioned(src: string): string {
  if (COVER_VERSION === '' || !src.startsWith('/imagine/')) return src
  return `${src}${src.includes('?') ? '&' : '?'}v=${COVER_VERSION}`
}

export interface CoverMediaProps {
  /** The address of the repo's cover for the key (`/imagine/<key>.webp`). */
  readonly cover: string
  /** The repo's clip, when the card has one (`/imagine/<key>`). */
  readonly motion?: string
  /**
   * The cover is already a file of this type (custom workflows:
   * `/comfy-custom-cover/<id>`, often an MP4): it is drawn as is, without the
   * choice among the repo's covers. The panel used to put it in an `<img>`
   * and the video did not show (2026-11-07).
   */
  readonly direct?: 'image' | 'video'
  readonly className?: string
}

/**
 * The image, or the video, that covers a card.
 * @param props - which action's cover, and which of the repo's clips it has.
 * @returns the element to draw.
 */
export function CoverMedia({ cover, motion, direct, className }: CoverMediaProps) {
  const { covers, ready } = useCoverInfos()
  if (direct === 'image') return <img className={className} src={cover} alt="" />
  if (direct === 'video') {
    return <video className={className} src={cover} autoPlay={!prefersReducedMotion()} muted loop playsInline aria-hidden="true" tabIndex={-1} />
  }
  /*
   * No choice is made before the list of custom covers arrives: mounting the
   * repo's clip and replacing it afterwards downloaded the wrong clip and
   * flashed one of its frames for an instant (4-11-2026, with the user's
   * animated covers: two conflicting requests for the same key). The slot
   * stays reserved by the CSS, empty while a request is in flight.
   */
  if (!ready) return <span className={className} aria-hidden="true" />
  const choice = coverChoiceOf(covers, cover, motion, prefersReducedMotion())
  if (choice.kind === 'image') return <img className={className} src={versioned(choice.src)} alt="" />
  if (choice.sources !== undefined) {
    return (
      <video
        className={className}
        poster={versioned(choice.poster)}
        autoPlay
        muted
        loop
        playsInline
        aria-hidden="true"
        tabIndex={-1}
      >
        {choice.sources.map(source => <source key={source.src} src={versioned(source.src)} type={source.type} />)}
      </video>
    )
  }
  return (
    <video
      className={className}
      src={versioned(choice.src)}
      poster={versioned(choice.poster)}
      autoPlay
      muted
      loop
      playsInline
      aria-hidden="true"
      tabIndex={-1}
    />
  )
}
