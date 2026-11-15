/**
 * The "{translate('imagine.extractFrame')}" panel body: the staged clip in a player, a time slider
 * with frame and second steps, and a button that saves the frame on screen as
 * a gallery image. Every saved frame is listed with the panels it can go to
 * next (edit it, animate it).
 */
import { translate } from './locale-store.ts'
import { useEffect, useState } from 'react'
import { mediaUrlOf, thumbUrlOf, THUMB_SMALL } from './gallery-api.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { FrameScrubber } from './FrameScrubber.tsx'
import { useHostEdit } from './Modal.tsx'
import { Still } from './Still.tsx'
import css from './WorkflowPanel.module.css'

/** The panels a saved frame can go on to. */
export type FrameCard = 'remix' | 'video' | 'style'

export interface FrameExtractorProps {
  readonly clip: GalleryItem
  readonly onSaved: (item: GalleryItem) => void
  readonly onUse: (item: GalleryItem, card: FrameCard) => void
}

export function FrameExtractor({ clip, onSaved, onUse }: FrameExtractorProps) {
  const [duration, setDuration] = useState(clip.duration ?? 0)
  const [time, setTime] = useState(0)
  const [saved, setSaved] = useState<readonly GalleryItem[]>([])
  // The same busy flag, error line and POST as the other host edits.
  const { busy: saving, error, clearError, run } = useHostEdit<GalleryItem>('/api/extract-frame', 'HTTP')

  useEffect(() => { setTime(0); setSaved([]); setDuration(clip.duration ?? 0); clearError() }, [clip.name])

  const save = (): Promise<void> => run({ name: clip.name, time }, (body) => {
    setSaved(current => [body, ...current.filter(entry => entry.name !== body.name)])
    onSaved(body)
  })

  return (
    <div className={css.block}>
      <h3 className={css.blockTitle}>{translate('imagine.framesPick')}</h3>
      <FrameScrubber clip={clip} time={time} onChange={setTime} onDuration={setDuration} controls preload="auto" />
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
