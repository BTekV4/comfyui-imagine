/**
 * The music-video form: one look, a genre, a voice and the words.
 *
 * A music video is four runs in a fixed order — the photos, the song, a shot
 * per photo, the join — and each one needs the names the previous produced.
 * Asked for in the written lane it is four sentences with the right file
 * selected each time; asked for here it is one form, and the host chains the
 * stages so closing the page does not strand a half-built video.
 */

import { useRef, useState } from 'react'
import { IMAGINE_ASPECTS, type ImagineAspect } from '../../../shared/imagine-media.ts'
import { useDismiss } from './use-dismiss.ts'
import css from './MusicClipPanel.module.css'
import { translate } from './locale-store.ts'

/** What the panel needs to draw itself and to start the chain. */
export interface MusicClipPanelProps {
  /** The lookbook entries this deployment loaded. */
  /** Start the video; the panel closes when this resolves. */
  readonly onStart: (form: {
    look: string
    genre: string
    voice: 'female' | 'male'
    lyrics: string
    aspect: ImagineAspect
  }) => Promise<void>
  /** Dismiss without starting anything. */
  readonly onClose: () => void
  /** The composer's current ratio, which the form opens on. */
  readonly aspect: ImagineAspect
}

/**
 * Render the music-video form.
 * @param props - the lookbook, and what to do with the answers.
 * @returns the panel.
 */
export function MusicClipPanel({ aspect, onStart, onClose }: MusicClipPanelProps) {
  // The look is written, not chosen: there is no catalogue to pick from since
  // the lookbook went away (2026-11-04), it is the words of the picture.
  const [look, setLook] = useState('')
  const [genre, setGenre] = useState('')
  const [voice, setVoice] = useState<'female' | 'male'>('female')
  const [lyrics, setLyrics] = useState('')
  const [ratio, setRatio] = useState<ImagineAspect>(aspect)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  // Escape or a press outside closes it, like every other popup of the
  // studio; not while the chain is being started, whose answer it waits for.
  useDismiss(box, () => { if (!busy) onClose() })

  const start = (): void => {
    if (busy || look.trim().length === 0) return
    setBusy(true)
    void onStart({ look, genre, voice, lyrics, aspect: ratio }).finally(() => { setBusy(false) })
  }

  return (
    <div ref={box} className={css.panel} role="dialog" aria-label={translate('imagine.makeClip')}>
      <div className={css.header}>
        <div>
          <div className={css.title}>{translate('imagine.makeClip')}</div>
          <div className={css.subtitle}>{translate('imagine.clipSubtitle')}</div>
        </div>
        <button type="button" className={css.closeBtn} aria-label={translate('imagine.clipClose')} onClick={onClose}>×</button>
      </div>

      <label className={css.field}>
        <span>{translate('imagine.look')}</span>
        <input
          type="text"
          value={look}
          placeholder={translate('imagine.clipLookHint')}
          onChange={(event) => { setLook(event.target.value) }}
        />
      </label>

      <label className={css.field}>
        <span>{translate('imagine.clipGenre')}</span>
        <input
          type="text"
          value={genre}
          placeholder={translate('imagine.clipGenreHint')}
          onChange={(event) => { setGenre(event.target.value) }}
        />
      </label>

      <div className={css.row}>
        <label className={css.field}>
          <span>{translate('imagine.clipVoice')}</span>
          <select
            value={voice}
            onChange={(event) => { setVoice(event.target.value === 'male' ? 'male' : 'female') }}
          >
            <option value="female">{translate('imagine.clipVoiceFemale')}</option>
            <option value="male">{translate('imagine.clipVoiceMale')}</option>
          </select>
        </label>
        <label className={css.field}>
          <span>{translate('imagine.clipRatio')}</span>
          <select
            value={ratio}
            onChange={(event) => { setRatio(event.target.value as ImagineAspect) }}
          >
            {IMAGINE_ASPECTS.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>

      <label className={css.field}>
        <span>{translate('imagine.clipLyrics')}</span>
        <textarea
          className={css.lyrics}
          rows={6}
          value={lyrics}
          placeholder={translate('imagine.clipLyricsHint')}
          onChange={(event) => { setLyrics(event.target.value) }}
        />
      </label>

      <button
        type="button"
        className={css.start}
        disabled={busy || look.trim().length === 0}
        onClick={start}
      >
        {translate('imagine.clipStart')}
      </button>
    </div>
  )
}
