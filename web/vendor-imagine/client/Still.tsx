/**
 * One still in the studio, which asks again when a load fails.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject, type CSSProperties } from 'react'
import { attemptSrc, mediaEpoch, RETRY_DELAYS, subscribeMediaEpoch } from './media-retry.ts'

/** What a still needs to draw itself and to ask again. */
export interface StillProps {
  /** The media URL, `?v=<mtime>` included when the caller has one. */
  readonly src: string
  /** Alternative text; the tiles are labelled by their card, so it defaults to none. */
  readonly alt?: string
  /**
   * The caller's class, since each place in the studio sizes its own stills.
   * A CSS module hands back `string | undefined`, so undefined is a value here
   * rather than an absent property.
   */
  readonly className?: string | undefined
  /** Whether to defer the load, for the stills far down a board. */
  readonly lazy?: boolean
  /** The element, for the viewer, which measures the picture it is showing. */
  readonly imageRef?: RefObject<HTMLImageElement | null>
  /** Called on every successful load, after the retries have been reset. */
  readonly onLoaded?: () => void
  /** Ask the browser for this one first: the viewer's picture, among a grid of thumbnails. */
  readonly urgent?: boolean
  /** Inline style for the picture (the viewer's zoom transform). */
  readonly style?: CSSProperties | undefined
}

/**
 * An `<img>` that retries instead of staying a black bed.
 *
 * A plain `<img>` gets exactly one request: the studio's media beds are `#111`,
 * so a still whose single request landed in a server restart reads as a black
 * picture for as long as the page is open, and reloading is the only way back.
 * This retries on a short backoff, and again whenever the network or the tab
 * comes back, so the board heals itself once the server answers.
 * @param props - the source, and how the caller wants it drawn.
 * @returns the image element.
 */
export function Still({ src, alt = '', className, lazy, imageRef, onLoaded, urgent, style }: StillProps) {
  const epoch = useSyncExternalStore(subscribeMediaEpoch, mediaEpoch, mediaEpoch)
  const [state, setState] = useState({ attempt: 0, tries: 0, broken: false })
  const timer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)

  const cancelRetry = (): void => {
    if (timer.current !== undefined) globalThis.clearTimeout(timer.current)
    timer.current = undefined
  }

  // A new file starts the attempts over; nothing carries across a src change,
  // not even a retry the old file had pending. A state that is already fresh
  // is kept as is: this also runs on mount, and a new object there rendered
  // every still twice.
  useEffect(() => {
    cancelRetry()
    setState(prev => (prev.attempt === 0 && prev.tries === 0 && !prev.broken ? prev : { attempt: 0, tries: 0, broken: false }))
  }, [src])

  // Only a still that gave up is asked for again, so coming back to the tab
  // does not re-download a board that is already on screen.
  useEffect(() => {
    setState(prev => (prev.broken ? { attempt: prev.attempt + 1, tries: 0, broken: false } : prev))
  }, [epoch])

  useEffect(() => cancelRetry, [])

  return (
    <img
      ref={imageRef}
      className={className}
      style={style}
      src={attemptSrc(src, state.attempt)}
      alt={alt}
      data-still-attempt={state.attempt > 0 ? state.attempt : undefined}
      data-still-broken={state.broken || undefined}
      {...lazy === true ? { loading: 'lazy' as const } : {}}
      {...urgent === true ? { fetchpriority: 'high' } : {}}
      onLoad={() => {
        // A still that loaded owes its next failure a full set of retries.
        if (state.tries !== 0 || state.broken) {
          setState(prev => ({ attempt: prev.attempt, tries: 0, broken: false }))
        }
        onLoaded?.()
      }}
      onError={() => {
        const delay = RETRY_DELAYS[state.tries]
        if (delay === undefined) {
          setState(prev => ({ ...prev, broken: true }))
          return
        }
        cancelRetry()
        timer.current = globalThis.setTimeout(() => {
          timer.current = undefined
          setState(prev => ({ attempt: prev.attempt + 1, tries: prev.tries + 1, broken: false }))
        }, delay)
      }}
    />
  )
}
