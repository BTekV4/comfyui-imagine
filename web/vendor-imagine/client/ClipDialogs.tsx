/**
 * The canvas's clip dialogs (2026-10-17, from Grok Imagine's video bar):
 * Trim keeps the stretch between two handles; Extract frame is the
 * frame extractor of the home panel, opened over the canvas.
 */
import { translate } from './locale-store.ts'
import { useRef, useState } from 'react'
import { mediaUrlOf } from './gallery-api.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { FrameExtractor, type FrameCard } from './FrameExtractor.tsx'
import { formatClock } from './format.ts'
import { DialogFooter, Modal, dialogButton, useHostEdit } from './Modal.tsx'
import css from './ClipDialogs.module.css'

/** `m:ss.cc`: a cut is placed to the hundredth. */
const clock = (seconds: number): string => formatClock(seconds, 2)

export function TrimDialog({ clip, onClose, onDone }: { clip: GalleryItem; onClose: () => void; onDone: (item: GalleryItem) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [duration, setDuration] = useState(clip.duration ?? 0)
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(clip.duration ?? 0)
  const { busy, error, run } = useHostEdit<GalleryItem>('/api/trim', 'HTTP')

  const seek = (time: number): void => { if (video.current !== null) { video.current.pause(); video.current.currentTime = time } }
  // Playing the selection stops at its end handle.
  const onTime = (): void => {
    const node = video.current
    if (node !== null && !node.paused && node.currentTime >= end) { node.pause(); node.currentTime = start }
  }
  const save = (): Promise<void> => run({ name: clip.name, start, end }, onDone)
  return (
    <Modal title={translate('imagine.clipTrimTitle')} onClose={onClose}>
      <video
        ref={video}
        className={css.player}
        src={mediaUrlOf(clip.name)}
        preload="auto"
        playsInline
        controls
        onLoadedMetadata={(event) => {
          const total = event.currentTarget.duration
          if (Number.isFinite(total)) { setDuration(total); setEnd(current => (current <= 0 || current > total ? total : current)) }
        }}
        onTimeUpdate={onTime}
      />
      <div className={css.rows}>
        <label className={css.row}>
          <span className={css.label}>{translate('imagine.clipFrom')} <b>{clock(start)}</b></span>
          <input type="range" min={0} max={Math.max(duration, 0.01)} step={0.01} value={start}
            onChange={(event) => { const next = Math.min(Number(event.target.value), end - 0.2); setStart(Math.max(0, next)); seek(Math.max(0, next)) }} />
        </label>
        <label className={css.row}>
          <span className={css.label}>{translate('imagine.clipTo')} <b>{clock(end)}</b></span>
          <input type="range" min={0} max={Math.max(duration, 0.01)} step={0.01} value={end}
            onChange={(event) => { const next = Math.max(Number(event.target.value), start + 0.2); setEnd(Math.min(duration, next)); seek(Math.min(duration, next)) }} />
        </label>
      </div>
      <DialogFooter
        lead={<button type="button" className={dialogButton.secondary} onClick={() => { const node = video.current; if (node !== null) { node.currentTime = start; void node.play() } }}>{translate('imagine.clipPlaySegment')}</button>}
        hint={error ?? translate('imagine.clipTrimLeft', { left: clock(Math.max(0, end - start)), total: clock(duration) })}
      >
        <button type="button" className={dialogButton.primary} disabled={busy || end - start < 0.2} onClick={() => { void save() }}>{busy ? translate('imagine.trimWorking') : translate('imagine.trim')}</button>
      </DialogFooter>
    </Modal>
  )
}

export function FramesDialog({ clip, onClose, onSaved, onUse }: {
  clip: GalleryItem
  onClose: () => void
  onSaved: (item: GalleryItem) => void
  /** The card the frame goes on to; the canvas may ignore it. */
  onUse: (item: GalleryItem, card: FrameCard) => void
}) {
  return (
    <Modal title={translate('imagine.extractFrame')} onClose={onClose}>
      <FrameExtractor clip={clip} onSaved={onSaved} onUse={onUse} />
    </Modal>
  )
}
