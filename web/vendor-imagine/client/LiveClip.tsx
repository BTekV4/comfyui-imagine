/**
 * A clip that plays itself in a grid of stills, the way Grok's saved page
 * does.
 *
 * The still is the poster and stays under the player, so a clip that never
 * starts — no autoplay on a phone in risparmio, a file the browser refuses —
 * still shows its picture. Only the clips that cross the screen mount a
 * `<video>`: the grid keeps thousands of pixels of cells in the DOM, and a
 * player each was the reason the old board opened forty media players at
 * once. Muted, looping, no controls: the click on the tile still opens the
 * viewer, and the transport lives there.
 *
 * The sound is the click's business (11/11/2026): the pointer says nothing.
 * A first click on the tile asks for this clip's sound and a second one takes
 * it back; the page keeps one clip heard at a time, so clicking another one
 * silences this. A browser that refuses sound before the first click on the
 * page gets the clip muted instead of paused.
 * @module LiveClip
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Still } from './Still.tsx'
import css from './LiveClip.module.css'

export interface LiveClipProps {
  /** The clip's original, which the browser streams in ranges. */
  readonly src: string
  /** The still cut from it: drawn before the first frame and kept beneath. */
  readonly poster: string
  /** The caller's class, since each place in the studio sizes its own media. */
  readonly className?: string | undefined
  /** Whether it may play: off with "Still", or when the reader keeps motion down. */
  readonly live: boolean
  /** Something else is over the grid (the viewer): the clip holds still. */
  readonly suspended?: boolean | undefined
  /** The mark drawn while it is not playing, as Grok marks a clip. */
  readonly badge?: ReactNode
  /**
   * Whether this clip is the one being heard: the page turns it on with a
   * click on the tile and off with the next one.
   */
  readonly sound?: boolean
}

export function LiveClip({ src, poster, className, live, suspended, badge, sound }: LiveClipProps) {
  const box = useRef<HTMLSpanElement>(null)
  const player = useRef<HTMLVideoElement>(null)
  const [armed, setArmed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)
  // Whether the clip is on screen, as the last observation said.
  const near = useRef(false)
  /*
   * Heard means: asked for with a click, and nothing over the grid. «Still»
   * does not silence a clip the user clicked: the click is an explicit ask.
   */
  const heard = sound === true && suspended !== true
  const hold = (!live && !heard) || suspended === true

  // A player is mounted the first time the clip comes into the screen, and
  // then plays and pauses with the screen. A clip scrolled away keeps its
  // place in the file; only what is visible streams.
  useEffect(() => {
    if (hold || failed) return
    const node = box.current
    if (node === null) return
    const watch = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      near.current = entry.isIntersecting
      if (entry.isIntersecting) setArmed(true)
      const video = player.current
      if (video === null) return
      if (entry.isIntersecting) void video.play().catch(() => undefined)
      else video.pause()
    }, { threshold: 0.25 })
    watch.observe(node)
    return () => { watch.disconnect() }
  }, [hold, failed])

  // "Still", or the viewer opening over the grid: the clip stops where it is.
  // Coming back plays it again only if it is still on screen.
  useEffect(() => {
    const video = player.current
    if (video === null) return
    if (hold) video.pause()
    else if (armed && near.current) void video.play().catch(() => undefined)
  }, [hold, armed])

  /*
   * The sound follows the click. Unmuting a clip the page has not been clicked
   * on yet can make the browser stop it: then it plays on, silent.
   */
  useEffect(() => {
    if (heard) setArmed(true)
  }, [heard])

  useEffect(() => {
    const video = player.current
    if (video === null) return
    if (heard) {
      video.muted = false
      void video.play().catch(() => {
        // The browser refuses sound (no gesture on the page yet): muted.
        video.muted = true
        void video.play().catch(() => undefined)
      })
    } else {
      video.muted = true
      if (hold) video.pause()
    }
  }, [heard, hold, armed])

  useEffect(() => () => { player.current?.pause() }, [])

  return (
    <span
      ref={box}
      className={css.frame}
      data-clip-state={failed ? 'failed' : armed ? (playing ? 'playing' : 'paused') : 'still'}
      data-clip-sound={heard || undefined}
    >
      <Still className={className} src={poster} lazy />
      {armed && !failed && (
        <video
          ref={player}
          className={`${className ?? ''} ${css.clip}`}
          src={src}
          poster={poster}
          muted
          loop
          playsInline
          preload="none"
          aria-hidden="true"
          data-playing={playing || undefined}
          onPlaying={() => { setPlaying(true) }}
          onPause={() => { setPlaying(false) }}
          onError={() => { setFailed(true); setPlaying(false) }}
        />
      )}
      {!playing && badge}
    </span>
  )
}
