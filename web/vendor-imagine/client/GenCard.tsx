/**
 * "Generate image" / "Generate video" on the canvas, as Grok Imagine's: a card
 * placed on the board where the result is meant to go, with its own prompt.
 * The files selected on the board travel with it as references — one photo
 * makes an image an edit of it, and a video starts from it.
 */
import { translate } from './locale-store.ts'
import { useEffect, useRef, useState } from 'react'
import { Still } from './Still.tsx'
import { thumbUrlOf, THUMB_SMALL } from './gallery-api.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { IconArrowUp } from './canvas-icons.tsx'
import css from './GenCard.module.css'

export interface GenCardProps {
  readonly x: number
  readonly y: number
  readonly mode: 'image' | 'video'
  /** The photos selected on the board when the card was opened. */
  readonly refs: readonly GalleryItem[]
  readonly zoom: number
  readonly onSubmit: (text: string) => void
  readonly onClose: () => void
}

export function GenCard({ x, y, mode, refs, zoom, onSubmit, onClose }: GenCardProps) {
  const [text, setText] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { field.current?.focus() }, [])
  const blocked = mode === 'video' && refs.length === 0
  const send = (): void => {
    if (blocked || (text.trim() === '' && mode === 'image')) return
    onSubmit(text.trim())
  }
  return (
    <div
      className={css.card}
      data-imagine-gencard
      style={{ left: x, top: y }}
      onPointerDown={(event) => { event.stopPropagation() }}
      onDoubleClick={(event) => { event.stopPropagation() }}
    >
      <div className={css.frame} data-mode={mode}>
        <span className={css.frameLabel}>{mode === 'image' ? translate('imagine.newImage') : translate('imagine.newVideo')}</span>
      </div>
      <form
        className={css.ask}
        style={{ transform: `scale(${String(Math.max(1, 1 / zoom))})` }}
        onSubmit={(event) => { event.preventDefault(); send() }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') onClose()
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() }
        }}
        onKeyUp={(event) => { event.stopPropagation() }}
      >
        {refs.length > 0 && (
          <div className={css.refs}>
            {refs.slice(0, 4).map(item => <Still key={item.name} className={css.ref} src={thumbUrlOf(item.name, THUMB_SMALL, item.mtime)} />)}
          </div>
        )}
        <textarea
          ref={field}
          className={css.field}
          rows={2}
          value={text}
          placeholder={blocked ? translate('imagine.pickPhotoFirst') : translate('imagine.prompt')}
          disabled={blocked}
          onChange={(event) => { setText(event.target.value) }}
        />
        <div className={css.row}>
          <button type="button" className={css.ghost} onClick={onClose}>{translate('imagine.cancel')}</button>
          <button type="submit" className={css.send} aria-label={translate('imagine.generate')} disabled={blocked || (mode === 'image' && text.trim() === '')}>
            <IconArrowUp size={14} strokeWidth={3.1} />
          </button>
        </div>
      </form>
    </div>
  )
}
