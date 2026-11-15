/**
 * What opens over a file, one at a time: the tile's right-click menu, the
 * dialogs (Trim, Extract frame, Precise edit, Crop, Remove
 * object), the Details card and the upscale menu.
 *
 * They were eight `useState`s in the page, each with its own `undefined`,
 * for things that are never open together. One value says which is open and
 * what it is open on (2026-10-25).
 * @module Overlays
 */

import type { FrameCard } from './FrameExtractor.tsx'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import type { ImagineRegion } from '../../../shared/imagine-types.ts'
import { FramesDialog, TrimDialog } from './ClipDialogs.tsx'
import { CropDialog } from './CropDialog.tsx'
import { EraseDialog } from './EraseDialog.tsx'
import { FileDetails } from './FileDetails.tsx'
import { mediaActions, type MediaActionKind } from './media-actions.tsx'
import { RegionEditDialog } from './RegionEditDialog.tsx'
import { TileMenu, type TileMenuEntry } from './TileMenu.tsx'
import { UpscaleMenu } from './UpscaleMenu.tsx'

/** The one thing open over the studio's files, and what it is open on. */
export type Overlay =
  | { readonly kind: 'menu'; readonly item: GalleryItem; readonly x: number; readonly y: number; readonly anchor: DOMRect }
  | { readonly kind: 'trim' | 'frames' | 'region' | 'crop' | 'erase'; readonly item: GalleryItem }
  | { readonly kind: 'details'; readonly item: GalleryItem; readonly anchor: DOMRect }
  | { readonly kind: 'upscale'; readonly items: readonly GalleryItem[]; readonly anchor: DOMRect; readonly batch: boolean }

/** The upscale menu's pick: a short side per kind of file. */
export type UpscalePick = { image?: number; video?: number }

export interface OverlaysProps {
  readonly overlay: Overlay | undefined
  /** A run is starting: the menu's GPU actions wait. */
  readonly busy: boolean
  /** The open project, for the menu's cover action. */
  readonly project: { readonly cover?: string | undefined } | undefined
  readonly onClose: () => void
  /** One of the file's actions, picked in the menu. */
  readonly onAction: (kind: MediaActionKind, item: GalleryItem, anchor: DOMRect) => void
  /** A file a dialog made: onto the board, centred and selected. */
  readonly onPlace: (item: GalleryItem) => void
  /** Precise edit sent: the zone and what to change in it. */
  readonly onRegion: (photo: GalleryItem, prompt: string, zone: { region: ImagineRegion } | { mask: string }) => void
  /** A frame the extractor saved, used as the button under it says. */
  readonly onUseFrame: (item: GalleryItem, card: FrameCard) => void
  /** The Details card's "Reuse": the prompt back in the composer, from its file. */
  readonly onReuse: (text: string, from: string | undefined) => void
  /** The Details card's source file, clicked. */
  readonly onOpenSource: (name: string) => void
  readonly onUpscale: (ask: { items: readonly GalleryItem[]; batch: boolean }, to: UpscalePick) => void
}

export function Overlays({
  overlay, busy, project, onClose, onAction, onPlace, onRegion, onUseFrame, onReuse, onOpenSource, onUpscale,
}: OverlaysProps) {
  if (overlay === undefined) return null
  const done = (item: GalleryItem): void => { onClose(); onPlace(item) }
  switch (overlay.kind) {
    case 'menu':
      return (
        <TileMenu
          x={overlay.x}
          y={overlay.y}
          entries={mediaActions(overlay.item, 'menu', {
            busy,
            ...project === undefined ? {} : { project },
          }).map((action): TileMenuEntry => ({
            label: action.label,
            run: () => { onAction(action.kind, overlay.item, overlay.anchor) },
            ...action.disabled === true ? { disabled: true } : {},
            ...action.danger === true ? { danger: true } : {},
            ...action.split === true ? { split: true } : {},
          }))}
          onClose={onClose}
        />
      )
    case 'trim':
      return <TrimDialog clip={overlay.item} onClose={onClose} onDone={done} />
    case 'region':
      return (
        <RegionEditDialog
          item={overlay.item}
          onClose={onClose}
          onRun={(zone, prompt) => {
            onClose()
            onRegion(overlay.item, prompt, zone.kind === 'box' ? { region: zone.region } : { mask: zone.mask })
          }}
        />
      )
    case 'crop':
      return <CropDialog item={overlay.item} onClose={onClose} onDone={done} />
    case 'erase':
      return <EraseDialog item={overlay.item} onClose={onClose} onDone={done} />
    case 'frames':
      return (
        <FramesDialog
          clip={overlay.item}
          onClose={onClose}
          onSaved={onPlace}
          onUse={(item, card) => {
            onClose()
            onPlace(item)
            onUseFrame(item, card)
          }}
        />
      )
    case 'details':
      return (
        <FileDetails
          item={overlay.item}
          anchor={overlay.anchor}
          onClose={onClose}
          onReuse={(text, from) => { onClose(); onReuse(text, from) }}
          onOpenSource={(name) => { onClose(); onOpenSource(name) }}
        />
      )
    case 'upscale':
      return (
        <UpscaleMenu
          items={overlay.items}
          anchor={overlay.anchor}
          onClose={onClose}
          onPick={(to) => { onClose(); onUpscale(overlay, to) }}
        />
      )
  }
}
