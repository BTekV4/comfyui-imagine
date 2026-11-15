/**
 * "Remove object" (2026-10-18): paint over what should go, and IOPaint
 * (LaMa, through its plugin) fills it in from what is around it. No prompt and no
 * ComfyUI: it runs with the PC of ComfyUI off. The result is a new photo
 * beside the original, which stays as it is.
 *
 * The brush is Precise edit's; the mask goes at the photo's own size,
 * because IOPaint refuses a mask of another size.
 */
import { translate } from './locale-store.ts'
import { useRef, useState } from 'react'
import { mediaUrlOf } from './gallery-api.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { DialogFooter, Modal, dialogButton, useHostEdit } from './Modal.tsx'
import { useMaskPainter } from './mask-painter.ts'
import { BrushTools } from './RegionEditDialog.tsx'
import { ZoneFrame } from './ZoneFrame.tsx'
import css from './RegionEditDialog.module.css'

/** The long side the strokes are drawn at; the mask is scaled up from it. */
const PAINT_SIDE = 1024

export function EraseDialog({ item, onClose, onDone }: { item: GalleryItem; onClose: () => void; onDone: (item: GalleryItem) => void }) {
  const [brush, setBrush] = useState(4)
  const [erase, setErase] = useState(false)
  const { busy, error, clearError, run } = useHostEdit<GalleryItem>('/plugin/iopaint/erase', 'erase')
  const natural = useRef<{ w: number; h: number }>()
  const painter = useMaskPainter({ side: PAINT_SIDE, color: '#ff4d6d', brush, erase, onStroke: clearError })
  const { painted } = painter

  const submit = async (): Promise<void> => {
    // White where to remove, black elsewhere, at the photo's own pixel size.
    // Rubbed back to nothing is nothing to remove.
    const mask = natural.current === undefined || !painter.hasPaint() ? undefined : painter.maskOf(natural.current)
    if (mask === undefined) { painter.setPainted(false); return }
    await run({ name: item.name, mask }, onDone)
  }

  return (
    // Closing while IOPaint works would drop its answer: wait for it.
    <Modal title={translate('imagine.eraseObject')} onClose={() => { if (!busy) onClose() }}>
      <div className={css.toolbar}>
        <BrushTools label={translate('imagine.brush')} brush={brush} erase={erase} onBrush={setBrush} onErase={setErase} />
      </div>
      <p className={css.lead}>{translate('imagine.eraseLead')}</p>
      <ZoneFrame
        src={mediaUrlOf(item.name)}
        region={undefined}
        onRegion={() => undefined}
        interactive={false}
        onPicture={(image) => {
          if (image.naturalWidth > 0) natural.current = { w: image.naturalWidth, h: image.naturalHeight }
          painter.sizePaint(image)
        }}
      >
        <canvas ref={painter.ref} className={css.paint} data-active={!busy || undefined} {...painter.handlers(!busy)} />
      </ZoneFrame>
      <DialogFooter
        spaced
        hint={error ?? (busy
          ? translate('imagine.eraseRunning')
          : painted ? translate('imagine.eraseOver') : translate('imagine.eraseEmpty'))}
      >
        {painted && !busy && <button type="button" className={dialogButton.secondary} onClick={painter.clear}>{translate('imagine.clearAll')}</button>}
        <button type="button" className={dialogButton.secondary} disabled={busy} onClick={onClose}>{translate('imagine.cancel')}</button>
        <button type="button" className={dialogButton.primary} disabled={!painted || busy} onClick={() => { void submit() }}>{busy ? translate('imagine.removeWorking') : translate('imagine.remove')}</button>
      </DialogFooter>
    </Modal>
  )
}
