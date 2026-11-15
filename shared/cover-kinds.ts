/**
 * Action covers: which types are allowed, and how they are recognised.
 *
 * A personal cover lives in `<data>/covers/<key>.<extension>` and wins over
 * the repo's one, which has the same name but the image's extension.
 * Since 4-11-2026 it can also be a short video — grok.com/imagine animates
 * them — so the type is decided by the CONTENT (the file's first bytes), not
 * by the extension the browser declares: an `.mp4` renamed `.webp`, or a
 * `.webp` sent as `image/*` when it is really a PNG, must still land on disk
 * with the right name and type.
 *
 * The module is shared because both sides read it: the server to recognise
 * and serve, the client to know what the user uploaded (not every file is a
 * cover: the rest is refused with a reason).
 * @module cover-kinds
 */

import { MEDIA_TYPES, sniffMedia } from './media-types.ts'

/** What a cover is: a still image or a short video. */
export type CoverKind = 'image' | 'video'

/** An allowed type: the extension on disk, the family and the MIME type. */
export interface CoverType {
  readonly ext: string
  readonly kind: CoverKind
  readonly mime: string
}

/**
 * The allowed types, in the order a key prefers them: when a key has more
 * than one file (a leftover from before the upload cleaned up after itself)
 * the first in the list wins.
 */
export const COVER_TYPES: readonly CoverType[] = (['webp', 'png', 'jpg', 'mp4', 'webm'] as const)
  .map(ext => ({ ext: `.${ext}`, kind: MEDIA_TYPES[ext].kind, mime: MEDIA_TYPES[ext].mime }))

/**
 * The upload cap: an animated cover is a short clip, not a film that fits in
 * a card. Twenty megabytes is already a lot for a silent loop.
 */
export const COVER_MAX_BYTES = 20 * 1024 * 1024

/** The type of an extension (with or without the dot), case-insensitive. */
export function coverTypeByExt(ext: string): CoverType | undefined {
  const lower = ext.toLowerCase()
  const dotted = lower.startsWith('.') ? lower : `.${lower}`
  return COVER_TYPES.find(type => type.ext === dotted)
}

/**
 * The file's type, if its name has an allowed extension.
 * @param name - a file name such as `video.webp`.
 * @returns the type, or undefined for a name that is not a cover.
 */
export function coverTypeOfName(name: string): CoverType | undefined {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? undefined : coverTypeByExt(name.slice(dot))
}

/**
 * The cover type of these bytes.
 *
 * The signatures are the ones the gallery trusts for its uploads
 * (`shared/media-types.ts`), narrowed to what a cover may be: WebP, PNG,
 * JPEG, ISO base media (`ftyp` at offset 4, which is mp4 and its cousins) and
 * WebM. A GIF or an audio file is not a cover.
 * @param bytes - what arrived, or just its first bytes.
 * @returns the type, or undefined when it is neither an image nor a video.
 */
export function coverTypeOfBytes(bytes: Uint8Array): CoverType | undefined {
  const sniffed = sniffMedia(bytes)
  return sniffed === undefined ? undefined : COVER_TYPES.find(type => type.mime === sniffed)
}
