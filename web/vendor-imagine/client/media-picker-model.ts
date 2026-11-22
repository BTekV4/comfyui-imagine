/**
 * The media picker's two lists and what one click does to the composer.
 *
 * The studio already has every file it can offer: one gallery under
 * `/comfy-media`, read newest first, and an upload route that writes into the
 * same folder under an `upload-` name. So the picker needs no archive of its
 * own: "Creations" is what the studio drew, "Uploads" is what came in through
 * the upload route, and the difference is the name the route writes. These
 * few functions are the whole model, kept out of the component so they can be
 * tested without a page.
 * @module media-picker-model
 */

import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { MAX_STAGED_FILES } from '../../../shared/imagine-chat.ts'

/**
 * The name prefix `saveGalleryUploadStream` gives every uploaded file
 * (`upload-<time>-<random>.<ext>`). It is the only mark on disk that tells an
 * upload from something the studio made.
 */
const UPLOAD_PREFIX = 'upload-'

/** Whether a gallery name is a file the user uploaded rather than drew. */
export function isUploaded(name: string): boolean {
  return name.startsWith(UPLOAD_PREFIX)
}

/** The two tabs, each in the order the gallery arrives (newest first). */
export interface PickerTabs {
  /** The stills and clips the studio made. */
  readonly creations: readonly GalleryItem[]
  /** Everything the user uploaded, audio included. */
  readonly uploads: readonly GalleryItem[]
}

/**
 * Split the inventory into the picker's two tabs.
 *
 * A creation is a picture or a clip (an audio track the studio makes is a
 * song, and the composer stages one through its own card); an upload is any
 * kind, because a track is uploaded to be sung over.
 * @param gallery - the whole gallery, newest first.
 * @returns the two lists.
 */
export function pickerTabs(gallery: readonly GalleryItem[]): PickerTabs {
  const creations: GalleryItem[] = []
  const uploads: GalleryItem[] = []
  for (const item of gallery) {
    if (isUploaded(item.name)) uploads.push(item)
    else if (item.kind === 'image' || item.kind === 'video') creations.push(item)
  }
  return { creations, uploads }
}

/**
 * How many tiles the panel draws before it asks for more.
 *
 * A gallery of a few thousand files is a page of tiles, not a page of
 * thousands of nodes: the grid draws this many rows-worth and grows as the
 * scroll reaches the end.
 */
export const PICKER_PAGE = 60

/**
 * The tiles to draw out of a longer list.
 * @param list - the list the tab holds, newest first.
 * @param shown - how many the panel has drawn so far.
 * @param page - one page's worth.
 * @returns at most `shown` entries, never more than the list holds.
 */
export function pageSlice<T>(list: readonly T[], shown: number, page = PICKER_PAGE): readonly T[] {
  const limit = Math.min(list.length, Math.max(page, shown))
  return list.slice(0, limit)
}

/**
 * How many tiles to draw after one more page is asked for.
 * @param shown - how many are drawn now.
 * @param total - how many the tab holds.
 * @param page - one page's worth.
 * @returns the new count, never past the total.
 */
export function moreShown(shown: number, total: number, page = PICKER_PAGE): number {
  return Math.min(total, Math.max(0, shown) + page)
}

/** What toggling one file did. */
export interface ToggleResult {
  /** The staging after the click. */
  readonly list: readonly GalleryItem[]
  /** True when the file was added, false when it was taken out or refused. */
  readonly added: boolean
  /** True when it could not be added: the staging is at its ceiling. */
  readonly full: boolean
}

/**
 * Add one file to the staging, or take it out when it is already there.
 *
 * The ceiling is the chat's own (`MAX_STAGED_FILES`): one written line is one
 * run per staged file, so the picker stops where the reader stops counting.
 * @param staged - what the composer holds now.
 * @param item - the file clicked.
 * @param limit - the ceiling, the shared one unless a test says otherwise.
 * @returns the new staging and what happened.
 */
export function toggleStaged(
  staged: readonly GalleryItem[],
  item: GalleryItem,
  limit: number = MAX_STAGED_FILES,
): ToggleResult {
  if (staged.some(entry => entry.name === item.name)) {
    return { list: staged.filter(entry => entry.name !== item.name), added: false, full: false }
  }
  if (staged.length >= limit) return { list: staged, added: false, full: true }
  return { list: [...staged, item], added: true, full: false }
}
