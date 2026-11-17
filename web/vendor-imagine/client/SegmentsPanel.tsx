/**
 * «Segments» in the viewer, copied from Grok Imagine's photo page as studied
 * live on 2026-11-15 (docs/note/imagine-grok-segmenti-riferimento.md):
 *
 * - the column: parts grouped by name, cut-out thumbnails, a check that
 *   appears on every row once something is picked, download on hover and
 *   download + bin on a picked row, «Download all»;
 * - over the photo: white 2px boxes for the part under the pointer and the
 *   picked ones, and the part's name following the cursor;
 * - the edit box floating under what is picked, in frosted glass; Enter
 *   applies, Shift+Enter breaks the line, Esc lets go; a text part opens the
 *   text editor (words, colour, typeface, size, alignment) above it.
 * @module SegmentsPanel
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconDownloadOutlineRegular, IconTrashOutlineRegular } from '../../shims/primitives/index.ts'
import { IconArrowUp } from './canvas-icons.tsx'
import { translate } from './locale-store.ts'
import {
  groupSegments, segmentFileUrl, TEXT_EDIT_FONTS,
  type ImagineSegment, type ImagineSegmentsIndex, type ImagineSegmentsStatus, type TextEditDraft, type TextEditFont,
} from '../../../shared/imagine-segments.ts'
import css from './SegmentsPanel.module.css'

/** A rectangle in viewport pixels. */
export interface Box { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

/**
 * Where the picture is drawn, in viewport pixels, measured again whenever it
 * may have moved (resize, load, zoom, pan).
 * @param imageRef - the picture.
 * @param moved - anything that moves it.
 */
export function useDrawnBox(imageRef: RefObject<HTMLImageElement | null>, moved: string): Box | undefined {
  const [box, setBox] = useState<Box>()
  useLayoutEffect(() => {
    const image = imageRef.current
    if (image === null) { setBox(undefined); return }
    const measure = (): void => {
      const r = image.getBoundingClientRect()
      setBox(now => (now !== undefined && now.left === r.left && now.top === r.top && now.width === r.width && now.height === r.height
        ? now
        : { left: r.left, top: r.top, width: r.width, height: r.height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(image)
    window.addEventListener('resize', measure)
    image.addEventListener('load', measure)
    image.addEventListener('transitionend', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      image.removeEventListener('load', measure)
      image.removeEventListener('transitionend', measure)
    }
  }, [imageRef, moved])
  return box
}

/* ── The column ───────────────────────────────────────────────────────────── */

export interface SegmentsPanelProps {
  readonly status: ImagineSegmentsStatus | undefined
  readonly error: string | undefined
  readonly onRetry: () => void
  readonly selected: readonly number[]
  readonly hover: number | undefined
  /** A part to bring into view in the list (picked on the photo); a new object each time. */
  readonly reveal: { readonly index: number } | undefined
  readonly onHover: (index: number | undefined) => void
  readonly onGroupHover: (indexes: readonly number[] | undefined) => void
  /** A row clicked: Shift, or a row already picked, adds or removes it. */
  readonly onPick: (index: number, add: boolean) => void
  /** A group's own row clicked: all of its parts. */
  readonly onPickGroup: (indexes: readonly number[]) => void
  /** The bin: pick the part and put «remove this layer» in the edit box. */
  readonly onRemove: (index: number) => void
}

export function SegmentsPanel({
  status, error, onRetry, selected, hover, reveal, onHover, onGroupHover, onPick, onPickGroup, onRemove,
}: SegmentsPanelProps) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const listRef = useRef<HTMLDivElement>(null)
  const index = status?.state === 'ready' ? status.index : undefined
  const picking = selected.length > 0
  useEffect(() => { setClosed(new Set()) }, [index?.photo])
  useEffect(() => {
    if (reveal === undefined) return
    const frame = requestAnimationFrame(() => {
      listRef.current?.querySelector(`[data-seg-idx="${String(reveal.index)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    return () => { cancelAnimationFrame(frame) }
  }, [reveal])

  const thumb = (segment: ImagineSegment): ReactNode => index !== undefined && (
    <span className={css.thumb}><img src={segmentFileUrl(index, segment.cut)} alt={segment.label} loading="lazy" /></span>
  )
  const names = (segment: ImagineSegment, label: string): ReactNode => (
    <span className={css.names}>
      <span className={css.label}>{label}</span>
      {segment.kind === 'text' && <span className={css.kind}>{translate('imagine.segmentText')}</span>}
    </span>
  )
  const row = (segment: ImagineSegment, nested: boolean): ReactNode => {
    const on = selected.includes(segment.index)
    return (
      <div key={segment.index} className={css.rowBox} data-nested={nested || undefined}>
        <div
          data-seg-idx={segment.index}
          className={css.row}
          data-hover={hover === segment.index || undefined}
          onMouseEnter={() => { onHover(segment.index) }}
          onMouseLeave={() => { onHover(undefined) }}
        >
          <button
            type="button"
            className={css.pick}
            aria-label={segment.label}
            aria-pressed={on}
            onClick={(event) => { onPick(segment.index, event.shiftKey || on) }}
          >
            <Check shown={picking} checked={on} />
            {thumb(segment)}
            {names(segment, segment.label)}
          </button>
          <div className={css.actions} data-shown={on || undefined}>
            {index !== undefined && (
              <a
                className={css.action}
                href={segmentFileUrl(index, segment.cut)}
                download={`${segment.label.replaceAll(/[^\p{L}\p{N}]+/gu, '-')}.png`}
                aria-label={translate('imagine.download')}
                title={translate('imagine.download')}
              >
                <IconDownloadOutlineRegular size={20} />
              </a>
            )}
            {on && (
              <button type="button" className={css.action} aria-label={translate('imagine.delete')} title={translate('imagine.delete')} onClick={() => { onRemove(segment.index) }}>
                <IconTrashOutlineRegular size={20} />
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  let body: ReactNode
  if (status?.state === 'failed' || error !== undefined) {
    body = (
      <div className={css.note}>
        <p className={css.error}>{status?.state === 'failed' ? status.error : error}</p>
        <button type="button" className={css.pill} onClick={onRetry}>{translate('imagine.retry')}</button>
      </div>
    )
  } else if (index === undefined) {
    // Grok's scan: pulsing rows under «Segmenting…» while the parts are found.
    body = (
      <div className={css.scan} aria-busy="true">
        <span className={css.scanLabel}>{translate('imagine.segmentsScanning')}</span>
        {[0, 1, 2, 3, 4, 5].map(n => (
          <div key={n} className={css.scanRow}><span className={css.scanThumb} /><span className={css.scanLine} /></div>
        ))}
      </div>
    )
  } else if (index.segments.length === 0) {
    body = <p className={css.note}>{translate('imagine.segmentsEmpty')}</p>
  } else {
    body = groupSegments(index.segments).map((group) => {
      if (group.members.length === 1) return row(group.members[0]!, false)
      const open = !closed.has(`${group.kind}:${group.label}`)
      const ids = group.members.map(member => member.index)
      const all = ids.every(id => selected.includes(id))
      return (
        <div key={`g-${group.kind}-${group.label}`}>
          <div className={css.rowBox}>
            <div className={css.row} onMouseEnter={() => { onGroupHover(ids) }} onMouseLeave={() => { onGroupHover(undefined) }}>
              <button type="button" className={css.pick} aria-label={group.label} aria-pressed={all} onClick={() => { onPickGroup(ids) }}>
                <Check shown={picking} checked={all} />
                {thumb(group.members[0]!)}
                {names(group.members[0]!, group.label)}
              </button>
              <button
                type="button"
                className={css.action}
                data-always
                aria-expanded={open}
                aria-label={translate(open ? 'imagine.collapse' : 'imagine.expand')}
                onClick={() => {
                  const key = `${group.kind}:${group.label}`
                  const next = new Set(closed)
                  if (open) next.add(key)
                  else next.delete(key)
                  setClosed(next)
                }}
              >
                <svg className={css.chevron} data-open={open || undefined} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="m6 15 6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
          {open && group.members.map(member => row(member, true))}
        </div>
      )
    })
  }

  return (
    <section className={css.panel} aria-label={translate('imagine.segments')} data-segment-ui="true">
      <div className={css.head}>
        <span className={css.title}>{translate('imagine.segments')}</span>
        {index !== undefined && index.segments.length > 0 && (
          <a className={css.pill} href={`/api/segments/zip?name=${encodeURIComponent(index.photo)}`} download>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v12.6M6 11.6l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {translate('imagine.downloadAll')}
          </a>
        )}
      </div>
      <div ref={listRef} className={css.list}>{body}</div>
    </section>
  )
}

/** The round check at the start of a row: absent until something is picked. */
function Check({ shown, checked }: { shown: boolean; checked: boolean }) {
  return (
    <span className={css.checkSlot} data-shown={shown || undefined} aria-hidden="true">
      <span className={css.check} data-checked={checked || undefined}>
        {checked && (
          <IconCheck size={10} strokeWidth={1.75} />
        )}
      </span>
    </span>
  )
}

/* ── Over the photo ───────────────────────────────────────────────────────── */

/**
 * The white boxes over the photo: the part under the pointer, the picked
 * ones and a hovered group. With a group, a box that holds all the others is
 * left out, as Grok does, so the person does not frame her own sandals.
 */
export function SegmentBoxes({ index, drawn, frame, shown, group }: {
  index: ImagineSegmentsIndex
  /** The picture, in viewport pixels. */
  drawn: Box
  /** The element the boxes are positioned in. */
  frame: RefObject<HTMLDivElement | null>
  shown: readonly number[]
  group: readonly number[] | undefined
}) {
  const origin = frame.current?.getBoundingClientRect()
  if (origin === undefined) return null
  const parts = [...new Set(shown)].map(id => index.segments.find(segment => segment.index === id)).filter((segment): segment is ImagineSegment => segment !== undefined)
  const holds = (a: ImagineSegment, b: ImagineSegment): boolean => a.bbox.x <= b.bbox.x + 1 && a.bbox.y <= b.bbox.y + 1
    && a.bbox.x + a.bbox.w >= b.bbox.x + b.bbox.w - 1 && a.bbox.y + a.bbox.h >= b.bbox.y + b.bbox.h - 1
  const kept = (group?.length ?? 0) > 1 && parts.length > 1 ? parts.filter(part => !parts.every(other => other === part || holds(part, other))) : parts
  const sx = drawn.width / index.width
  const sy = drawn.height / index.height
  return (
    <div className={css.boxes} aria-hidden="true">
      {(kept.length > 0 ? kept : parts).map(part => (
        <div
          key={part.index}
          className={css.box}
          style={{
            left: drawn.left - origin.left + part.bbox.x * sx,
            top: drawn.top - origin.top + part.bbox.y * sy,
            width: part.bbox.w * sx,
            height: part.bbox.h * sy,
          }}
        />
      ))}
    </div>
  )
}

/** The part's name, following the cursor 16px above it. */
export function SegmentLabel({ label, frame, start }: {
  label: string
  /** The photo's frame: the label follows the pointer over it. */
  frame: RefObject<HTMLElement | null>
  /** Where the pointer was when the part under it was found. */
  start: { x: number; y: number }
}) {
  /*
   * The pointer's position is this label's own state, read from the frame's
   * events here: kept in the viewer, every mouse move re-rendered the whole
   * viewer and its panels to move one line of text.
   */
  const [at, setAt] = useState(start)
  useEffect(() => {
    const node = frame.current
    if (node === null) return
    const onMove = (event: PointerEvent): void => { setAt({ x: event.clientX, y: event.clientY }) }
    node.addEventListener('pointermove', onMove)
    return () => { node.removeEventListener('pointermove', onMove) }
  }, [frame])
  return createPortal(
    <div className={css.cursorLabel} style={{ left: Math.max(80, Math.min(at.x, window.innerWidth - 80)), top: Math.max(28, at.y - 16) }}>{label}</div>,
    document.body,
  )
}

/** A short hint over the photo («Shift + click…»). */
export function SegmentHint({ drawn, text }: { drawn: Box; text: string }) {
  return createPortal(
    <div className={css.hint} style={{ left: drawn.left + drawn.width / 2, top: drawn.top + 12 }}>{text}</div>,
    document.body,
  )
}

/* ── The edit box ─────────────────────────────────────────────────────────── */

/**
 * Where the edit box goes: under everything picked, 8px below, centred on it
 * and kept inside the picture; 320px wide, 280 for several parts, 360 for a
 * text part, never wider than the picture less 16.
 */
export function editBoxPlace(index: ImagineSegmentsIndex, picked: readonly ImagineSegment[], drawn: Box): CSSProperties {
  const left = Math.min(...picked.map(part => part.bbox.x)) / index.width
  const right = Math.max(...picked.map(part => part.bbox.x + part.bbox.w)) / index.width
  const bottom = Math.max(...picked.map(part => part.bbox.y + part.bbox.h)) / index.height
  const wanted = picked.length > 1 ? 280 : picked[0]?.kind === 'text' ? 360 : 320
  const width = Math.min(wanted, drawn.width - 16)
  const centre = drawn.left + (left + right) / 2 * drawn.width
  return {
    left: Math.max(drawn.left + 8, Math.min(centre - width / 2, drawn.left + drawn.width - width - 8)),
    top: drawn.top + bottom * drawn.height + 8,
    width,
  }
}

/**
 * Grok's «+» for a reference photo beside an edit: a dashed square that
 * becomes the picture's thumbnail, with × to take it away. One photo, since
 * Krea 2 reads one second image.
 */
export function RefPicker({ file, onFile }: { file: File | undefined; onFile: (file: File | undefined) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (file === undefined) { setUrl(undefined); return }
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => { URL.revokeObjectURL(next) }
  }, [file])
  return (
    <span className={css.refRow}>
      {url === undefined
        ? (
          <button type="button" className={css.refAdd} aria-label={translate('imagine.refAdd')} title={translate('imagine.refAdd')} onClick={() => { input.current?.click() }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        )
        : (
          <button type="button" className={css.refThumb} aria-label={translate('imagine.refRemove')} title={translate('imagine.refRemove')} onClick={() => { onFile(undefined) }}>
            <img src={url} alt="" />
            <span aria-hidden="true">×</span>
          </button>
        )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const picked = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (picked !== undefined) onFile(picked)
        }}
      />
    </span>
  )
}

export function SegmentEditBox({ picked, place, prompt, onPrompt, busy, error, onApply, onLetGo }: {
  picked: readonly ImagineSegment[]
  place: CSSProperties
  prompt: string
  onPrompt: (text: string) => void
  busy: boolean
  error: string | undefined
  /** Apply: the prompt, and the text editor's fields for a text part. */
  /** Apply: the prompt, the text editor's fields for a text part, the reference photo. */
  onApply: (prompt: string, text: TextEditDraft | undefined, reference: File | undefined) => void
  onLetGo: () => void
}) {
  const textPart = picked.length === 1 && picked[0]?.kind === 'text' ? picked[0] : undefined
  const [draft, setDraft] = useState<TextEditDraft | undefined>(textPart === undefined ? undefined : { text: textPart.label, size: 0 })
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setDraft(textPart === undefined ? undefined : { text: textPart.label, size: 0 }) }, [textPart?.index])
  // Open with the caret at the end, so the bin's «remove this layer» is ready to send.
  useEffect(() => {
    const box = field.current
    if (box === null) return
    box.focus()
    box.setSelectionRange(box.value.length, box.value.length)
  }, [picked.map(part => part.index).join(',')])
  const changed = draft !== undefined && (draft.text.trim() !== textPart?.label || draft.color !== undefined || draft.font !== undefined || draft.size !== 0 || draft.align !== undefined)
  const ready = (prompt.trim().length > 0 || changed) && !busy
  const [reference, setReference] = useState<File>()
  useEffect(() => { setReference(undefined) }, [picked.map(part => part.index).join(',')])
  const apply = (): void => { if (ready) onApply(prompt.trim(), changed ? draft : undefined, reference) }
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Esc lets go of the parts only: the page's own Esc would close the viewer.
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onLetGo(); return }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); apply() }
  }
  const send = (
    <button type="button" className={css.send} data-ready={ready || undefined} disabled={!ready} aria-label={translate('imagine.regionEdit')} title={translate('imagine.regionEdit')} onClick={apply}>
      <IconArrowUp />
    </button>
  )
  let inner: ReactNode
  if (picked.length > 1) {
    inner = (
      <div className={css.glass}>
        <div className={css.chipRow}><span className={css.chip}>{translate('imagine.segmentsSelected', { count: picked.length })}</span></div>
        <div className={css.refBar}><RefPicker file={reference} onFile={setReference} /></div>
        <div className={css.multiField}>
          <textarea ref={field} rows={1} value={prompt} disabled={busy} placeholder={translate('imagine.describeEditShort')} className={css.multiText} onChange={(event) => { onPrompt(event.currentTarget.value) }} onKeyDown={keys} />
          {prompt.trim().length > 0 && send}
        </div>
      </div>
    )
  } else if (draft !== undefined) {
    inner = (
      <div className={css.glass}>
        <TextEditor draft={draft} onChange={setDraft} />
        <div className={css.refBar}><RefPicker file={reference} onFile={setReference} /></div>
        <div className={css.textField}>
          <textarea ref={field} rows={1} value={prompt} disabled={busy} placeholder={translate('imagine.textEditPlaceholder')} className={css.textText} onChange={(event) => { onPrompt(event.currentTarget.value) }} onKeyDown={keys} />
          {send}
        </div>
      </div>
    )
  } else {
    inner = (
      <div className={css.glass}>
        <div className={css.refBar} data-top><RefPicker file={reference} onFile={setReference} /></div>
        <textarea ref={field} rows={1} value={prompt} disabled={busy} placeholder={translate('imagine.describeEdit')} className={css.singleText} onChange={(event) => { onPrompt(event.currentTarget.value) }} onKeyDown={keys} />
        {prompt.trim().length > 0 && <span className={css.sendCorner}>{send}</span>}
      </div>
    )
  }
  return createPortal(
    <div className={css.editBox} style={place} data-segment-ui="true">
      {inner}
      {error !== undefined && <p className={css.editError}>{error}</p>}
    </div>,
    document.body,
  )
}

/** The text part's own fields, as Grok's «Edit text». */
function TextEditor({ draft, onChange }: { draft: TextEditDraft; onChange: (next: TextEditDraft) => void }) {
  const set = (patch: Partial<TextEditDraft>): void => { onChange({ ...draft, ...patch }) }
  const unset = (key: 'color' | 'font' | 'align'): void => {
    const next: Record<string, unknown> = { ...draft }
    delete next[key]
    onChange(next as unknown as TextEditDraft)
  }
  return (
    <div className={css.textEditor}>
      <label className={css.textLabel}>
        <span>{translate('imagine.textEditText')}</span>
        <input className={css.textInput} value={draft.text} onChange={(event) => { set({ text: event.currentTarget.value }) }} />
      </label>
      <div className={css.textTools}>
        <label className={css.colorSwatch} title={translate('imagine.textEditColor')} style={{ background: draft.color ?? 'conic-gradient(#ff3b30, #ffcc00, #34c759, #0a84ff, #bf5af2, #ff3b30)' }}>
          <input type="color" aria-label={translate('imagine.textEditColor')} value={draft.color ?? '#ffffff'} onChange={(event) => { set({ color: event.currentTarget.value }) }} />
        </label>
        {draft.color !== undefined && (
          <button type="button" className={css.tool} aria-label={translate('imagine.textEditColorKeep')} title={translate('imagine.textEditColorKeep')} onClick={() => { unset('color') }}>×</button>
        )}
        <select
          className={css.fontSelect}
          aria-label={translate('imagine.textEditFont')}
          value={draft.font ?? ''}
          onChange={(event) => { const value = event.currentTarget.value; if (value === '') unset('font'); else set({ font: value as TextEditFont }) }}
        >
          <option value="">{translate('imagine.textEditFontNone')}</option>
          {TEXT_EDIT_FONTS.map(font => <option key={font.id} value={font.id}>{translate(`imagine.textFont.${font.id}`)}</option>)}
        </select>
        <button type="button" className={css.tool} aria-label={translate('imagine.textEditSmaller')} title={translate('imagine.textEditSmaller')} onClick={() => { set({ size: Math.max(-3, draft.size - 1) }) }}>A−</button>
        <button type="button" className={css.tool} aria-label={translate('imagine.textEditLarger')} title={translate('imagine.textEditLarger')} onClick={() => { set({ size: Math.min(3, draft.size + 1) }) }}>A+</button>
        {(['left', 'center', 'right'] as const).map(align => (
          <button
            key={align}
            type="button"
            className={css.tool}
            aria-pressed={draft.align === align}
            aria-label={translate(`imagine.textEditAlign.${align}`)}
            title={translate(`imagine.textEditAlign.${align}`)}
            onClick={() => { if (draft.align === align) unset('align'); else set({ align }) }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d={align === 'left' ? 'M4 6h16M4 12h10M4 18h13' : align === 'center' ? 'M4 6h16M7 12h10M5.5 18h13' : 'M4 6h16M10 12h10M7 18h13'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  )
}
