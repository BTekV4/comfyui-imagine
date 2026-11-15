/**
 * What a media file is: the type each extension promises and the type its
 * first bytes actually are.
 *
 * One table and one sniffer for the gallery, the cover uploads and the vision
 * calls: until 2026-11-07 the magic bytes were read in two places and the
 * extension table was written out three times, each with its own subset.
 * Callers that accept fewer formats filter what these return rather than
 * keeping a copy of their own.
 *
 * Shared, and so free of Node: the page reads it for the covers it uploads.
 * @module media-types
 */

import type { MediaKind } from './imagine-types.ts'

/** The type a file is served as, and the kind the gallery lists it as. */
export interface MediaType {
  readonly kind: MediaKind
  readonly mime: string
}

/**
 * Every extension the studio knows, lowercase and without the dot.
 *
 * `m4v` is not one: nothing here writes it and the upload refuses it. A `.mov`
 * is `video/mp4`: QuickTime is the ISO BMFF cousin the upload check already
 * reads like mp4, and Firefox refuses to play `video/quicktime`.
 */
export const MEDIA_TYPES = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  webp: { kind: 'image', mime: 'image/webp' },
  gif: { kind: 'image', mime: 'image/gif' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  mov: { kind: 'video', mime: 'video/mp4' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
} as const satisfies Readonly<Record<string, MediaType>>

/**
 * The type an extension promises.
 * @param ext - the extension, with or without the dot, in any case.
 * @returns the type, or undefined for an extension the studio does not know.
 */
export function mediaTypeOfExt(ext: string): MediaType | undefined {
  const bare = ext.toLowerCase().replace(/^\./, '')
  return Object.hasOwn(MEDIA_TYPES, bare) ? (MEDIA_TYPES as Readonly<Record<string, MediaType>>)[bare] : undefined
}

/** Every type the first bytes of a file can say it is. */
export type SniffedMedia =
  | 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  | 'video/mp4' | 'video/webm'
  | 'audio/ogg' | 'audio/flac' | 'audio/wav' | 'audio/mpeg'

/** True when `bytes` carry `signature` at `at`. */
function carries(bytes: Uint8Array, at: number, signature: readonly number[] | string): boolean {
  const codes = typeof signature === 'string' ? [...signature].map(char => char.charCodeAt(0)) : signature
  if (bytes.length < at + codes.length) return false
  return codes.every((code, index) => bytes[at + index] === code)
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]
const EBML = [0x1a, 0x45, 0xdf, 0xa3]

/**
 * The format a file's leading bytes actually are, whatever its name says.
 *
 * Generated `.webp` files on this deployment are PNGs, so every caller that
 * picks an encoder, a served type or an upload check reads it here. Any ISO
 * base media file (`ftyp` at offset 4: mp4, mov, m4a) reads as `video/mp4`,
 * and Matroska as `video/webm`. The stills and containers are tried before
 * the audio signatures, and the bare MPEG frame sync, the weakest of them,
 * last.
 * @param bytes - at least the first 16 bytes of the file.
 * @returns the type, or undefined when it is none the studio reads.
 */
export function sniffMedia(bytes: Uint8Array): SniffedMedia | undefined {
  if (carries(bytes, 0, PNG)) return 'image/png'
  if (carries(bytes, 0, JPEG)) return 'image/jpeg'
  if (carries(bytes, 0, 'RIFF') && carries(bytes, 8, 'WEBP')) return 'image/webp'
  if (carries(bytes, 0, 'GIF87a') || carries(bytes, 0, 'GIF89a')) return 'image/gif'
  if (carries(bytes, 4, 'ftyp')) return 'video/mp4'
  if (carries(bytes, 0, EBML)) return 'video/webm'
  if (carries(bytes, 0, 'OggS')) return 'audio/ogg'
  if (carries(bytes, 0, 'fLaC')) return 'audio/flac'
  if (carries(bytes, 0, 'RIFF') && carries(bytes, 8, 'WAVE')) return 'audio/wav'
  // MPEG audio is either ID3-tagged or a bare frame sync (0xFF Ex/Fx).
  if (carries(bytes, 0, 'ID3')) return 'audio/mpeg'
  const first = bytes[0]
  const second = bytes[1]
  if (first === 0xff && second !== undefined && (second & 0xe0) === 0xe0) return 'audio/mpeg'
  return undefined
}
