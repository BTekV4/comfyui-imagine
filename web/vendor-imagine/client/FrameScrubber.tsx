/**
 * The frame scrubber: a clip in a player, a time slider, and the buttons that
 * move by a second or by a frame.
 *
 * «Extract frames» (FrameExtractor) and an uploaded card's frame control
 * (custom-workflow-panel) each had their own copy of it, with the same clamp,
 * the same slider and the same five buttons; this is the one both draw.
 * Controlled: the caller owns the time, so the extractor can save the frame on
 * screen and the custom card can send it as a field value.
 * @module FrameScrubber
 */
import { useEffect, useRef, useState } from 'react'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { formatClock } from './format.ts'
import { mediaUrlOf } from './gallery-api.ts'
import { translate } from './locale-store.ts'
import css from './WorkflowPanel.module.css'

/** One step of the frame buttons: the common 30 fps, close enough at 24/25. */
const FRAME_STEP = 1 / 30

/** `m:ss.mmm`, the precision a frame needs. */
const clock = (seconds: number): string => formatClock(seconds, 3)

export interface FrameScrubberProps {
  readonly clip: GalleryItem
  /** The instant shown, in seconds. */
  readonly time: number
  /** A new instant: the slider, a step button, or the player itself. */
  readonly onChange: (seconds: number) => void
  /** The player's own controls (play, volume), as the extractor shows them. */
  readonly controls?: boolean
  /** How much of the clip to load up front: the extractor wants the frames ready. */
  readonly preload?: 'auto' | 'metadata'
  /** A shorter player, for a scrubber that sits among other fields. */
  readonly compact?: boolean
  /** Told the clip's real length once the player has read it. */
  readonly onDuration?: (seconds: number) => void
}

export function FrameScrubber({ clip, time, onChange, controls = false, preload = 'metadata', compact = false, onDuration }: FrameScrubberProps) {
  const player = useRef<HTMLVideoElement>(null)
  const [duration, setDuration] = useState(clip.duration ?? 0)
  // Another clip: its stored length until the player reads the real one.
  useEffect(() => { setDuration(clip.duration ?? 0) }, [clip.name, clip.duration])

  // The last instant is a hair before the end: at `duration` itself some
  // browsers show a black frame.
  const seek = (next: number): void => {
    const clamped = Math.min(Math.max(0, next), Math.max(0, duration - 0.001))
    onChange(clamped)
    if (player.current !== null) {
      player.current.pause()
      player.current.currentTime = clamped
    }
  }
  const top = Math.max(duration, 0.001)

  return (
    <>
      <video
        ref={player}
        className={compact ? `${css.framePlayer} ${css.framePlayerCompact}` : css.framePlayer}
        src={mediaUrlOf(clip.name)}
        preload={preload}
        playsInline
        controls={controls}
        muted
        onLoadedMetadata={(event) => {
          const seconds = event.currentTarget.duration
          if (!Number.isFinite(seconds)) return
          setDuration(seconds)
          onDuration?.(seconds)
        }}
        onTimeUpdate={(event) => { onChange(event.currentTarget.currentTime) }}
        onSeeked={(event) => { onChange(event.currentTarget.currentTime) }}
      />
      <input
        className={css.frameSlider}
        type="range"
        min={0}
        max={top}
        step={0.001}
        value={Math.min(time, top)}
        aria-label={translate('imagine.framesInstant')}
        onChange={(event) => { seek(Number(event.target.value)) }}
      />
      <div className={css.frameControls}>
        <button type="button" className={css.secondary} onClick={() => { seek(time - 1) }} aria-label={translate('imagine.framesBack')}>−1 s</button>
        <button type="button" className={css.secondary} onClick={() => { seek(time - FRAME_STEP) }} aria-label={translate('imagine.framePrev')}>{translate('imagine.frameBack')}</button>
        <span className={css.frameClock} aria-live="polite">{clock(time)} / {clock(duration)}</span>
        <button type="button" className={css.secondary} onClick={() => { seek(time + FRAME_STEP) }} aria-label={translate('imagine.frameNext')}>{translate('imagine.frameForward')}</button>
        <button type="button" className={css.secondary} onClick={() => { seek(time + 1) }} aria-label={translate('imagine.framesForward')}>+1 s</button>
      </div>
    </>
  )
}
