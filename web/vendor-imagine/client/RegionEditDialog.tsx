/**
 * "Precise edit" (2026-10-17, from Grok Imagine's photo bar): mark a zone
 * of the picture and say what to change there. The host crops the zone with
 * some context around it, edits only that, and stitches it back — the rest of
 * the photo comes back as its own pixels.
 *
 * The zone is a rectangle or a painted shape. Painting is for what a box
 * cannot follow — a sleeve, a strand of hair — and is sent as a mask.
 */
import { translate } from './locale-store.ts'
import { useState } from 'react'
import { mediaUrlOf } from './gallery-api.ts'
import type { GalleryItem, ImagineRegion } from '../../../shared/imagine-types.ts'
import { DialogFooter, Modal, dialogButton } from './Modal.tsx'
import { useMaskPainter } from './mask-painter.ts'
import { Segmented } from './Pills.tsx'
import { MIN_ZONE, ZoneFrame } from './ZoneFrame.tsx'
import css from './RegionEditDialog.module.css'

/** The painted zone, as the run takes it. */
export type PaintedZone = { readonly kind: 'box'; readonly region: ImagineRegion } | { readonly kind: 'mask'; readonly mask: string }

/**
 * The brush's size and its eraser, for the two dialogs that paint a mask
 * (Precise edit and Remove object): they had a copy each.
 * @param props.label - what the size is called beside its slider.
 */
export function BrushTools({ label, brush, erase, onBrush, onErase }: {
  label: string
  brush: number
  erase: boolean
  onBrush: (size: number) => void
  onErase: (erase: boolean) => void
}) {
  return (
    <>
      <label className={css.size}>
        <span>{label}</span>
        <input type="range" min={1} max={20} step={0.5} value={brush} aria-label={translate('imagine.brushSize')} onChange={(event) => { onBrush(Number(event.target.value)) }} />
      </label>
      <button type="button" className={css.mode} data-on={erase || undefined} aria-pressed={erase} onClick={() => { onErase(!erase) }}>{translate('imagine.eraser')}</button>
    </>
  )
}

/** The long side the mask is painted at; the host scales it to the photo. */
const MASK_SIDE = 1024

/** How the zone is drawn: a dragged box or a painted mask. */
const REGION_MODES = ['box', 'brush'] as const

export function RegionEditDialog({ item, onClose, onRun }: {
  item: GalleryItem
  onClose: () => void
  onRun: (zone: PaintedZone, prompt: string) => void
}) {
  const [mode, setMode] = useState<'box' | 'brush'>('box')
  const [region, setRegion] = useState<ImagineRegion>()
  const [text, setText] = useState('')
  const [brush, setBrush] = useState(6)
  const [erase, setErase] = useState(false)
  const painter = useMaskPainter({ side: MASK_SIDE, color: '#4f8cff', brush, erase })
  const { painted } = painter

  const hasZone = mode === 'box' ? region !== undefined && region.w >= MIN_ZONE && region.h >= MIN_ZONE : painted
  const ready = hasZone && text.trim() !== ''

  const submit = (): void => {
    if (!ready) return
    if (mode === 'box' && region !== undefined) {
      onRun({ kind: 'box', region }, text.trim())
      return
    }
    // Erased back to nothing is no zone: the crop node has nothing to frame.
    if (!painter.hasPaint()) {
      painter.setPainted(false)
      return
    }
    const mask = painter.maskOf()
    if (mask !== undefined) onRun({ kind: 'mask', mask }, text.trim())
  }

  return (
    <Modal title={translate('imagine.regionEdit')} onClose={onClose}>
      <div className={css.toolbar}>
        <Segmented
          label={translate('imagine.regionMode')}
          values={REGION_MODES}
          value={mode}
          onPick={setMode}
          format={entry => translate(entry === 'box' ? 'imagine.regionBox' : 'imagine.brush')}
          group={css.modes}
          pill={css.mode}
        />
        {mode === 'brush' && <BrushTools label={translate('imagine.size')} brush={brush} erase={erase} onBrush={setBrush} onErase={setErase} />}
      </div>
      <p className={css.lead}>
        {mode === 'box'
          ? translate('imagine.regionDrag')
          : translate('imagine.regionPaint')}
      </p>
      <ZoneFrame
        src={mediaUrlOf(item.name)}
        region={region}
        onRegion={setRegion}
        interactive={mode === 'box'}
        onPicture={painter.sizePaint}
      >
        <canvas ref={painter.ref} className={css.paint} data-active={mode === 'brush' || undefined} {...painter.handlers(mode === 'brush')} />
      </ZoneFrame>
      <form
        className={css.ask}
        onSubmit={(event) => { event.preventDefault(); submit() }}
        // The canvas listens for its own shortcuts on the window; Escape is
        // the dialog's, taken before it gets here.
        onKeyDown={(event) => { event.stopPropagation() }}
        onKeyUp={(event) => { event.stopPropagation() }}
      >
        <input
          className={css.field}
          value={text}
          placeholder={hasZone ? translate('imagine.regionWhat') : translate('imagine.regionFirst')}
          aria-label={translate('imagine.regionWhatShort')}
          autoFocus
          onChange={(event) => { setText(event.target.value) }}
        />
        <DialogFooter
          hint={mode === 'box'
            ? region === undefined ? translate('imagine.regionNone') : translate('imagine.regionMove')
            : painted ? translate('imagine.regionOver') : translate('imagine.regionNoPaint')}
        >
          {mode === 'box' && region !== undefined && (
            <button type="button" className={dialogButton.secondary} onClick={() => { setRegion(undefined) }}>{translate('imagine.regionClear')}</button>
          )}
          {mode === 'brush' && painted && (
            <button type="button" className={dialogButton.secondary} onClick={painter.clear}>{translate('imagine.clearAll')}</button>
          )}
          <button type="submit" className={dialogButton.primary} disabled={!ready}>{translate('imagine.regionApply')}</button>
        </DialogFooter>
      </form>
    </Modal>
  )
}
