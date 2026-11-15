/**
 * The tile's right-click menu, as Grok Imagine's canvas has (2026-10-17):
 * the same actions as the icon bar plus the few that only make sense here —
 * copy the picture, make it the project's cover.
 */
import { translate } from './locale-store.ts'
import { useEffect, useRef } from 'react'
import { useDismiss } from './use-dismiss.ts'
import css from './TileMenu.module.css'

export interface TileMenuEntry {
  readonly label: string
  readonly run: () => void
  readonly danger?: boolean
  readonly disabled?: boolean
  /** A rule above this entry. */
  readonly split?: boolean
}

export function TileMenu({ x, y, entries, onClose }: { x: number; y: number; entries: readonly TileMenuEntry[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useDismiss(box, onClose)
  useEffect(() => {
    window.addEventListener('wheel', onClose, { passive: true })
    box.current?.querySelector('button')?.focus()
    return () => { window.removeEventListener('wheel', onClose) }
  }, [onClose])
  const width = 240
  const height = entries.length * 34 + 16
  const left = Math.min(x, window.innerWidth - width - 8)
  const top = Math.min(y, window.innerHeight - height - 8)
  return (
    <div ref={box} className={css.menu} role="menu" style={{ left, top, width }} onContextMenu={(event) => { event.preventDefault() }}>
      {entries.map(entry => (
        <div key={entry.label}>
          {entry.split === true && <div className={css.rule} />}
          <button
            type="button"
            role="menuitem"
            className={css.item}
            data-danger={entry.danger || undefined}
            disabled={entry.disabled}
            onClick={() => { onClose(); entry.run() }}
          >
            {entry.label}
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Copy a still to the clipboard as PNG. The studio's .webp stills are often
 * PNG bytes, and the clipboard takes only image/png, so it is redrawn first.
 */
export async function copyStill(url: string): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || navigator.clipboard?.write === undefined) {
    throw new Error(translate('imagine.copyBlocked'))
  }
  const blob = await (await fetch(url)).blob()
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  const png = await new Promise<Blob>((resolve, reject) => { canvas.toBlob(out => (out === null ? reject(new Error(translate('imagine.copyFailed'))) : resolve(out)), 'image/png') })
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}
