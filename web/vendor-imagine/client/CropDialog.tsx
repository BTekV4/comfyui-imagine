/**
 * "Crop" on the canvas (2026-10-17, from Grok Imagine's photo bar): keep
 * a rectangle of a photo as a new picture beside it. The original stays as it
 * is — the viewer's crop overwrote it in place.
 */
import { translate } from './locale-store.ts'
import { useState } from 'react'
import { mediaUrlOf } from './gallery-api.ts'
import type { GalleryItem, ImagineRegion } from '../../../shared/imagine-types.ts'
import { DialogFooter, Modal, dialogButton, useHostEdit } from './Modal.tsx'
import { Segmented } from './Pills.tsx'
import { MIN_ZONE, ZoneFrame } from './ZoneFrame.tsx'
import css from './RegionEditDialog.module.css'

/** The ratios offered, as width over height in pixels; undefined is free (its label is translated). */
const FREE = 'free'
const RATIOS: readonly { label: string; value: number | undefined }[] = [
  { label: FREE, value: undefined },
  { label: '1:1', value: 1 },
  { label: '4:5', value: 4 / 5 },
  { label: '9:16', value: 9 / 16 },
  { label: '16:9', value: 16 / 9 },
  { label: '3:2', value: 3 / 2 },
]

export function CropDialog({ item, onClose, onDone }: { item: GalleryItem; onClose: () => void; onDone: (item: GalleryItem) => void }) {
  const [region, setRegion] = useState<ImagineRegion>()
  const [ratio, setRatio] = useState<number | undefined>(undefined)
  const [natural, setNatural] = useState<{ w: number; h: number }>()
  const { busy, error, run } = useHostEdit<GalleryItem>('/api/crop-copy', 'HTTP')
  // A pixel ratio in fractions of this photo: the frame measures in fractions.
  const fraction = ratio === undefined || natural === undefined ? undefined : ratio * natural.h / natural.w

  /** The largest centred rectangle of a ratio, so picking one shows it at once. */
  const centred = (value: number | undefined): ImagineRegion | undefined => {
    if (value === undefined || natural === undefined) return undefined
    const f = value * natural.h / natural.w
    const w = f >= 1 ? 1 : f
    const h = f >= 1 ? 1 / f : 1
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
  }

  const ready = region !== undefined && region.w >= MIN_ZONE && region.h >= MIN_ZONE
  const pixels = region === undefined || natural === undefined
    ? undefined
    : `${String(Math.round(region.w * natural.w))}×${String(Math.round(region.h * natural.h))} px`

  const save = async (): Promise<void> => {
    if (!ready) return
    await run({ name: item.name, region }, onDone)
  }

  return (
    <Modal title={translate('imagine.crop')} onClose={onClose}>
      <Segmented
        label={translate('imagine.cropRatio')}
        values={RATIOS.map(entry => entry.label)}
        value={RATIOS.find(entry => entry.value === ratio)?.label ?? ''}
        format={label => label === FREE ? translate('imagine.cropFree') : label}
        onPick={(label) => {
          const value = RATIOS.find(entry => entry.label === label)?.value
          setRatio(value)
          setRegion(centred(value) ?? region)
        }}
        group={css.ratios}
        pill={css.mode}
      />
      <ZoneFrame
        src={mediaUrlOf(item.name)}
        region={region}
        onRegion={setRegion}
        {...fraction === undefined ? {} : { ratio: fraction }}
        onPicture={(image) => { setNatural({ w: image.naturalWidth, h: image.naturalHeight }) }}
      />
      <DialogFooter
        spaced
        hint={error ?? (ready ? translate('imagine.cropDone', { pixels: pixels ?? '' }) : translate('imagine.cropDrag'))}
      >
        <button type="button" className={dialogButton.secondary} onClick={onClose}>{translate('imagine.cancel')}</button>
        <button type="button" className={dialogButton.primary} disabled={!ready || busy} onClick={() => { void save() }}>{busy ? translate('imagine.cropWorking') : translate('imagine.crop')}</button>
      </DialogFooter>
    </Modal>
  )
}
