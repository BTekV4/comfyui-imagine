/**
 * What can be done to one file, for the three places that offer it: the
 * tile's own bar, its right-click menu and the viewer's column.
 *
 * Each surface used to write its own list, and by 2026-10-20 they had drifted:
 * the tile offered the upscale on a clip with no readable size and the viewer
 * did not, "Crop" checked the file's format only in the viewer, and the
 * viewer's upscale stayed enabled while a run was busy. The rules live here
 * once; what differs between the surfaces — the order, "Duplicate" and the cover
 * only in the menu, background removal only on the tile — is the list each
 * surface names below, not a copy of the rules.
 */

import { translate } from './locale-store.ts'
import type { ReactNode } from 'react'
import {
  IconDownloadOutlineRegular, IconEditOutlineRegular, IconFullscreenOutlineRegular, IconShareOutlineRegular,
  IconSparkleRegular, IconTrashOutlineRegular,
} from '../../shims/primitives/index.ts'
import { IconCut, IconCutout, IconDetails, IconExtend, IconFrame, IconRegion, IconUpscale, IconVideo, CropIcon, EraseIcon, IconHeart } from './canvas-icons.tsx'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { isCroppable } from './imagine-crop.ts'
import { upscaleEligible } from './imagine-settings.ts'
import { INSTAGRAM_PLUGIN, IOPAINT_PLUGIN, pluginEnabled } from './plugin-presence.ts'

/** Every action a file can be offered. */
export type MediaActionKind =
  | 'details' | 'open' | 'remix' | 'region' | 'crop' | 'erase' | 'duplicate' | 'video' | 'bg' | 'copy'
  | 'extend' | 'trim' | 'frames' | 'voice' | 'upscale' | 'cover' | 'like' | 'download' | 'publish' | 'delete'

/** Where the actions are shown. */
export type MediaSurface = 'tile' | 'menu' | 'viewer'

/** Which actions each surface offers, in its own order. */
const SURFACES: Readonly<Record<MediaSurface, readonly MediaActionKind[]>> = {
  tile: ['details', 'open', 'remix', 'region', 'crop', 'erase', 'video', 'bg', 'extend', 'trim', 'frames', 'voice', 'upscale', 'download', 'publish', 'delete'],
  menu: ['details', 'open', 'remix', 'region', 'crop', 'erase', 'duplicate', 'video', 'copy', 'extend', 'trim', 'frames', 'cover', 'download', 'publish', 'delete'],
  // As Grok's post column (2026-11-15): the big actions, the foot icons, then the «…» menu.
  // No 'region' or 'crop': the viewer has its own in-place tools for both
  // («Precise edit» and PostCrop), so the list never drew them.
  viewer: ['bg', 'video', 'extend', 'publish', 'like', 'copy', 'download', 'remix', 'erase', 'trim', 'frames', 'upscale', 'duplicate', 'cover', 'details', 'delete'],
}

/** Actions that queue GPU work or remove a file: off while a run is busy on the file. */
const BUSY_OFF: ReadonlySet<MediaActionKind> = new Set(['region', 'video', 'bg', 'extend', 'voice', 'upscale', 'delete'])

/**
 * Actions that hand the file to something else — the composer, a dialog that
 * covers the studio — and so close the viewer when they are picked there.
 * Only read for the viewer, which no longer offers 'region' or 'crop'.
 */
export const CLOSES_VIEWER: ReadonlySet<MediaActionKind> = new Set(['remix', 'video', 'extend', 'erase'])

/** One action as a surface draws it. */
export interface MediaAction {
  readonly kind: MediaActionKind
  readonly label: string
  readonly disabled?: boolean
  readonly danger?: boolean
  /** The menu draws a rule above it. */
  readonly split?: boolean
}

/** What the rules read beyond the file itself. */
export interface MediaActionContext {
  /** A run is busy on this file. */
  readonly busy: boolean
  /** The open project, when there is one: the cover action needs it. */
  readonly project?: { readonly cover?: string | undefined }
  /** Whether the file has a "Like". */
  readonly liked?: boolean
}

function offered(kind: MediaActionKind, item: GalleryItem, ctx: MediaActionContext): boolean {
  const still = item.kind === 'image'
  const clip = item.kind === 'video'
  switch (kind) {
    case 'open':
      return still || clip
    case 'publish':
      // Nowhere to publish without the Instagram plugin; offered while unknown.
      return (still || clip) && pluginEnabled(INSTAGRAM_PLUGIN) !== false
    case 'erase':
      // IOPaint does the removal, and it is a plugin (2026-11-15): offered
      // while the host has not answered, like Publish.
      return still && pluginEnabled(IOPAINT_PLUGIN) !== false
    case 'remix':
    case 'region':
    case 'duplicate':
    case 'video':
    case 'bg':
    case 'copy':
      return still
    case 'crop':
      return still && isCroppable(item.name)
    case 'extend':
    case 'trim':
    case 'frames':
      return clip
    case 'voice':
      return item.kind === 'audio'
    case 'upscale':
      // A clip with no readable size is not a clip: offering the upscale would
      // queue a GPU run over bytes nothing can decode. A still without a size
      // is only an old inventory entry and is still offered.
      return upscaleEligible(item) && (!clip || (item.width !== undefined && item.height !== undefined))
    case 'cover':
      return ctx.project !== undefined && (still || clip)
    default:
      return true
  }
}

/**
 * The label of one action.
 * @param kind - the action.
 * @param item - the file, for the labels that depend on it.
 * @param ctx - the state the labels read.
 * @returns the text the surface shows.
 */
function mediaActionLabel(kind: MediaActionKind, item: GalleryItem, ctx: MediaActionContext): string {
  switch (kind) {
    case 'details': return translate('imagine.details')
    case 'open': return translate('imagine.fullScreen')
    case 'remix': return translate('imagine.remix')
    case 'region': return translate('imagine.regionEdit')
    case 'crop': return translate('imagine.crop')
    case 'erase': return translate('imagine.eraseObject')
    case 'duplicate': return translate('imagine.duplicate')
    case 'video': return translate('imagine.makeVideo')
    case 'bg': return translate('imagine.bgRemoval')
    case 'copy': return translate('imagine.copyImage')
    case 'extend': return translate('imagine.extendVideo')
    case 'trim': return translate('imagine.trim')
    case 'frames': return translate('imagine.extractFrame')
    case 'voice': return translate('imagine.changeVoice')
    case 'upscale': return translate('imagine.upscale')
    case 'cover': return ctx.project?.cover === item.name ? translate('imagine.isCover') : translate('imagine.setCover')
    case 'like': return ctx.liked === true ? translate('imagine.likedByYou') : translate('imagine.likeThis')
    case 'download': return translate('imagine.download')
    case 'publish': return translate('imagine.publishToInstagram')
    case 'delete': return translate('imagine.delete')
  }
}

/**
 * The actions one surface offers on one file, in that surface's order.
 * @param item - the file.
 * @param surface - where they are drawn.
 * @param ctx - the state the rules read.
 * @returns the actions, each with its label and whether it is enabled.
 */
export function mediaActions(item: GalleryItem, surface: MediaSurface, ctx: MediaActionContext): readonly MediaAction[] {
  return SURFACES[surface]
    .filter(kind => offered(kind, item, ctx))
    .map(kind => ({
      kind,
      label: mediaActionLabel(kind, item, ctx),
      ...(ctx.busy && BUSY_OFF.has(kind)) || (kind === 'cover' && ctx.project?.cover === item.name) ? { disabled: true } : {},
      ...kind === 'delete' ? { danger: true } : {},
      ...surface === 'menu' && (kind === 'download' || kind === 'delete') ? { split: true } : {},
    }))
}

/**
 * The glyph of one action, for the tile's bar and the viewer's column.
 * @param props - the action and, for "Like", whether the file is liked.
 */
export function MediaActionIcon({ kind, liked }: { kind: MediaActionKind; liked?: boolean }): ReactNode {
  switch (kind) {
    case 'details': return <IconDetails />
    case 'open': return <IconFullscreenOutlineRegular size={16} />
    case 'remix': return <IconEditOutlineRegular size={16} />
    case 'region': return <IconRegion />
    case 'crop': return <CropIcon />
    case 'erase': return <EraseIcon />
    case 'video': return <IconVideo />
    case 'bg': return <IconCutout />
    case 'extend': return <IconExtend />
    case 'trim': return <IconCut />
    case 'frames': return <IconFrame />
    case 'voice': return <IconSparkleRegular size={16} />
    case 'upscale': return <IconUpscale />
    // Two sheets, one over the other, as Grok's «Copy image».
    case 'copy': return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" /></svg>
    case 'download': return <IconDownloadOutlineRegular size={16} />
    case 'publish': return <IconShareOutlineRegular size={16} />
    case 'delete': return <IconTrashOutlineRegular size={16} />
    case 'like': return <IconHeart {...liked === true ? { color: '#ff4d6d' } : {}} />
    default: return null
  }
}

/**
 * Save one file through the browser's download, as a link click would.
 * @param href - the file's address.
 * @param name - the name to save it under.
 */
export function downloadUrl(href: string, name: string): void {
  const link = document.createElement('a')
  link.href = href
  link.download = name
  link.click()
}
