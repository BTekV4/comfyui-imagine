/**
 * The "{translate('imagine.extractFrame')}" panel body: the staged clip in a player, a time slider
 * with frame and second steps, and a button that saves the frame on screen as
 * a gallery image. Every saved frame is listed with the panels it can go to
 * next (edit it, animate it).
 */
import { messageOf } from './message-of.ts'
import { translate } from './locale-store.ts'
import { useEffect, useRef, useState } from 'react'
import { mediaUrlOf, thumbUrlOf, THUMB_SMALL } from './gallery-api.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { formatClock } from './format.ts'
import { postJson } from './http.ts'
import { Still } from './Still.tsx'
import css from './WorkflowPanel.module.css'

/** One step of the frame buttons: the common 30 fps, close enough at 24/25. */
const FRAME_STEP = 1 / 30

/** The panels a saved frame can go on to. */
export type FrameCard = 'remix' | 'video' | 'style'

export interface FrameExtractorProps {
  readonly clip: GalleryItem
  readonly onSaved: (item: GalleryItem) => void
  readonly onUse: (item: GalleryItem, card: FrameCard) => void
}

/** `m:ss.mmm`, the precision a frame needs. */
const clock = (seconds: number): string => formatClock(seconds, 3)

export function FrameExtractor({ clip, onSaved, onUse }: FrameExtractorProps) {
  const video = useRef<HTMLVideoElement>(null)
  const [duration, setDuration] = useState(clip.duration ?? 0)
  const [time, setTime] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState<readonly GalleryItem[]>([])

  useEffect(() => { setTime(0); setSaved([]); setError(undefined) }, [clip.name])

  const seek = (next: number): void => {
    const clamped = Math.min(Math.max(0, next), Math.max(0, duration - 0.001))
    setTime(clamped)
    if (video.current !== null) {
      video.current.pause()
      video.current.currentTime = clamped
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      const body = await postJson<GalleryItem>('/api/extract-frame', { name: clip.name, time }, 'HTTP')
      setSaved(current => [body, ...current.filter(entry => entry.name !== body.name)])
      onSaved(body)
    } catch (caught: unknown) {
      setError(messageOf(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={css.block}>
      <h3 className={css.blockTitle}>{translate('imagine.framesPick')}</h3>
      <video
        ref={video}
        className={css.framePlayer}
        src={mediaUrlOf(clip.name)}
        preload="auto"
        playsInline
        controls
        muted
        onLoadedMetadata={(event) => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration) }}
        onTimeUpdate={(event) => { setTime(event.currentTarget.currentTime) }}
        onSeeked={(event) => { setTime(event.currentTarget.currentTime) }}
      />
      <input
        className={css.frameSlider}
        type="range"
        min={0}
        max={Math.max(duration, 0.001)}
        step={0.001}
        value={time}
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
      <div className={`${css.runBar} ${css.runBarStatic}`}>
        <button type="button" className={css.run} disabled={saving || duration === 0} onClick={() => { void save() }}>
          <span>{saving ? translate('imagine.framesSaving') : translate('imagine.framesSave')}</span>
        </button>
        <span className={css.runHint} role="status">{error ?? translate('imagine.framesStored')}</span>
      </div>
      {saved.length > 0 && (
        <div className={css.frames}>
          {saved.map(item => (
            <div key={item.name} className={css.frameCard}>
              <a href={mediaUrlOf(item.name)} target="_blank" rel="noreferrer" title={item.name}>
                <Still className={css.frameThumb} src={thumbUrlOf(item.name, THUMB_SMALL, item.mtime)} />
              </a>
              <div className={css.frameUse}>
                <button type="button" className={css.example} onClick={() => { onUse(item, 'remix') }}>{translate('imagine.editShort')}</button>
                <button type="button" className={css.example} onClick={() => { onUse(item, 'video') }}>{translate('imagine.makeVideo')}</button>
                <button type="button" className={css.example} onClick={() => { onUse(item, 'style') }}>{translate('imagine.changeStyle')}</button>
                <a className={css.example} href={mediaUrlOf(item.name)} download={item.name}>{translate('imagine.download')}</a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
