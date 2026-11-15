/**
 * The bar under the full-screen view, as Grok Imagine's post page has it
 * (studied 2026-11-15). On a photo it is an edit box — «Describe the edit» —
 * with the prompt the photo was made with offered above it to reuse; what is
 * sent edits this photo (only the painted zone when «Modifica precisa» is
 * on: the viewer decides). On a clip it is still the prompt the clip was made
 * with, editable, and a button that makes it again. A file with no run behind
 * it gets a plain line that goes to the project chat.
 */
import { translate } from './locale-store.ts'
import { useEffect, useState } from 'react'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { fetchFileDetails, wordsOf, type FileOrigin } from './file-origin.ts'
import { RefPicker } from './SegmentsPanel.tsx'
import css from './ViewerPrompt.module.css'

export type { FileOrigin } from './file-origin.ts'

/** The runs a changed prompt can make again. */
const RERUNNABLE = new Set(['generate', 'remix', 'video', 'loop', 'extend', 'look'])

export function ViewerPrompt({ item, busy, placeholder, onEdit, onRerun, onAsk }: {
  item: GalleryItem
  busy: boolean
  /** What the edit box says while empty (a zone being painted says so). */
  placeholder?: string | undefined
  /** A photo: the words that edit it, and Grok's «+» reference photo. Absent, the bar reruns or asks. */
  onEdit?: ((prompt: string, reference: File | undefined) => void) | undefined
  onRerun: (origin: FileOrigin, prompt: string) => void
  onAsk: (text: string) => void
}) {
  const [origin, setOrigin] = useState<FileOrigin>()
  const [text, setText] = useState('')
  const [reference, setReference] = useState<File>()
  const editing = onEdit !== undefined
  useEffect(() => {
    let cancelled = false
    setOrigin(undefined)
    setText('')
    setReference(undefined)
    fetchFileDetails(item.name)
      .then((body) => {
        if (cancelled) return
        setOrigin(body.origin)
        // A clip's bar holds its own prompt; a photo's starts empty, its
        // prompt offered above to reuse, as Grok's «Usa».
        if (!editing) setText(wordsOf(body.origin) ?? '')
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [item.name, editing])
  const used = wordsOf(origin)
  const rerun = !editing && origin !== undefined && RERUNNABLE.has(origin.action)
  const submit = (): void => {
    const line = text.trim()
    if (line === '' || busy) return
    if (editing) { onEdit(line, reference); setText(''); setReference(undefined); return }
    if (rerun && origin !== undefined) onRerun(origin, line)
    else onAsk(line)
  }
  return (
    <form
      className={css.bar}
      onSubmit={(event) => { event.preventDefault(); submit() }}
      onKeyDown={(event) => { event.stopPropagation() }}
    >
      {editing && used !== undefined && used !== text.trim() && (
        <div className={css.used}>
          <span className={css.usedText} title={used}>{used}</span>
          <button type="button" className={css.usedButton} onClick={() => { setText(used) }}>{translate('imagine.usePrompt')}</button>
        </div>
      )}
      <div className={css.row}>
        {editing && <span className={css.ref}><RefPicker file={reference} onFile={setReference} /></span>}
        <textarea
          className={css.field}
          rows={1}
          value={text}
          placeholder={editing ? placeholder ?? translate('imagine.describeEditRefs') : rerun ? translate('imagine.askRerun') : translate('imagine.askChange')}
          aria-label={editing ? translate('imagine.describeEditRefs') : rerun ? translate('imagine.askUsed') : translate('imagine.askChange')}
          onChange={(event) => { setText(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() }
          }}
        />
        <button
          type="submit"
          className={css.send}
          data-round={editing || !rerun || undefined}
          disabled={busy || text.trim() === ''}
          aria-label={editing ? translate('imagine.edit') : rerun ? translate('imagine.redoWithDescription') : translate('imagine.sendToChat')}
          title={editing ? translate('imagine.edit') : rerun ? translate('imagine.redoWithDescription') : translate('imagine.sendToChat')}
        >
          {rerun
            ? translate('imagine.runAgain')
            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        </button>
      </div>
    </form>
  )
}
