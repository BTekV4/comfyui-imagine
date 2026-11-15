/**
 * Gallery inventory over the Comfy output directory: classify one basename,
 * reject traversal, and list produced media newest-first.
 * @module tool-comfy/gallery
 */

import type { Dirent, Stats } from 'node:fs'
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../atomic-write/index.ts'
import { mapWithConcurrency } from './media-tools.ts'
import { forgetWrittenPrompt } from './written-prompts.ts'
import { forgetNote } from './imagine-notes.ts'
// These three import this module back; only functions cross the cycle, and
// only when a delete runs, never at load.
import { forgetSeen } from './imagine-sight.ts'
import { forgetPlacedItem } from './imagine-store.ts'
import { forgetThumbs } from './media-thumbs.ts'
import type { GalleryItem, GalleryTool, MediaKind } from '../../../shared/imagine-types.ts'
import { UPSCALE_MAX_SIDE, UPSCALE_VIDEO_MAX_SIDE } from '../../../shared/imagine-media.ts'
import { message } from '../../src/messages.ts'
import { MEDIA_TYPES, sniffMedia, type MediaType } from '../../../shared/media-types.ts'

/**
 * Every extension the gallery knows: the kind it lists the file as and the
 * type the media route serves it with. The table is `shared/media-types.ts`
 * since 2026-11-07 (one table since 2026-10-25, when the route's own copy was
 * found without `.mov` and served it as octet-stream).
 */
const MEDIA_EXTENSIONS: Readonly<Record<string, MediaType>> = MEDIA_TYPES

/** The extensions of one kind, from {@link MEDIA_EXTENSIONS}. */
const extensionsOf = (kind: MediaKind): ReadonlySet<string> =>
  new Set(Object.entries(MEDIA_EXTENSIONS).filter(([, entry]) => entry.kind === kind).map(([ext]) => ext))

/** Image extensions the gallery treats as stills. */
export const IMAGE_EXTENSIONS = extensionsOf('image')
/** Video extensions the gallery treats as clips. */
export const VIDEO_EXTENSIONS = extensionsOf('video')
/** Audio extensions the gallery treats as songs. */
export const AUDIO_EXTENSIONS = extensionsOf('audio')

/** A basename's extension, lowercase and without the dot ('' when it has none). */
const extOf = (name: string): string => (name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined) ?? ''

/**
 * The type a gallery file is served with.
 * @param name - the basename.
 * @returns the MIME type, or undefined when the extension is not gallery media.
 */
export function mimeOf(name: string): string | undefined {
  return MEDIA_EXTENSIONS[extOf(name)]?.mime
}

/**
 * How many files the gallery probes at once.
 *
 * The work is a header read per file on a local disk, so the useful limit is
 * about overlapping I/O waits without opening hundreds of descriptors. Eight
 * measured well below the serial loop it replaces; more than this stopped
 * helping and only added open descriptors.
 */
const GALLERY_PROBE_CONCURRENCY = 8

/** Classify a basename as image, video, audio, or not gallery media. */
export function kindOf(name: string): MediaKind | undefined {
  return MEDIA_EXTENSIONS[extOf(name)]?.kind
}

/**
 * The tool prefix encoded in the declared output name
 * (`generate_image-<digest>.png`). Unknown prefixes stay unset.
 */
function toolOf(name: string): GalleryItem['tool'] | undefined {
  return TOOL_PREFIXES.find(([prefix]) => name.startsWith(prefix))?.[1]
}

/*
 * Every prefix the producers write, next to the action it means. The studio's
 * chained actions and the spoken line are here as much as the tool calls: the
 * gallery's own filter reads this to say what a file came from.
 */
const TOOL_PREFIXES: readonly (readonly [string, GalleryTool])[] = [
  ['generate_image-', 'generate_image'],
  ['edit_image-', 'edit_image'],
  ['create_video-', 'create_video'],
  ['upscale_image-', 'upscale_image'],
  ['upscale_video-', 'upscale_video'],
  ['remove_background-', 'remove_background'],
  ['generate_music-', 'generate_music'],
  ['generate_lookbook-', 'generate_lookbook'],
  ['animated_background-', 'animated_background'],
  ['extend_video-', 'extend_video'],
  ['change_voice-', 'change_voice'],
  ['speak_text-', 'speak_text'],
  ['videoclip-', 'videoclip'],
  ['recreate_video-', 'recreate_video'],
  // A recreation's first frame is drawn by Krea 2: it is a generated image
  // like the others, and the history lists it there.
  ['recreate_frame-', 'generate_image'],
  // «Rigenera dettaglio» writes its files with this prefix: without this row
  // they would all end up under «Altri» in the history.
  ['regenerate_detail-', 'regenerate_detail'],
  // «Object swap»: the object changed, removed or added in the clip (2026-11-06).
  ['object_swap-', 'object_swap'],
  // «Character swap»: the main person of the clip played by the one in a photo.
  ['swap_person-', 'swap_person'],
  // «Illumina la foto»: the photo re-lit with one of the light looks (2026-11-06).
  ['relight-', 'relight'],
]

/**
 * Accept only a single-segment basename that cannot traverse the output
 * directory. Empty names, separators, and `..` are rejected.
 * @param name - the requested file name.
 * @returns the same name when it is a safe basename.
 */
export function safeBasename(name: string): string | undefined {
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return undefined
  }
  return name
}

/**
 * List every image/video in the output directory, newest first.
 * Missing directories yield an empty list.
 *
 * The listing reads the directory once with its entry types and then probes
 * the candidates with bounded concurrency. It used to `stat` and decode every
 * header strictly one after another: on a board holding ~1600 media that is
 * over three thousand serialized operations, and the route took about a
 * second on every visit — the slowest call the studio makes. `withFileTypes`
 * drops the entries that are not media files before any of that work starts,
 * and the probes run in small batches because the work is I/O on a local disk,
 * not CPU. One `stat` per candidate stays: `readdir` reports the entry type
 * but not its size or timestamp, and the studio sorts by the timestamp.
 * @param outputDir - the validated media output directory.
 * @returns the gallery inventory.
 */
export async function listGallery(outputDir: string): Promise<GalleryItem[]> {
  /*
   * The directory's mtime is read before the directory: an entry added while
   * the listing is built moves it past the value kept, and the next call
   * lists again.
   */
  let dirMtime: number
  try {
    dirMtime = (await stat(outputDir)).mtimeMs
  } catch (error: unknown) {
    if (isMissing(error)) return []
    throw error
  }
  const known = listings.get(outputDir)
  if (known !== undefined && known.dirMtime === dirMtime && await stillSettled(outputDir, known)) return [...known.items]
  const builtAt = Date.now()
  const items = await readGallery(outputDir)
  listings.set(outputDir, { dirMtime, builtAt, items })
  return [...items]
}

/**
 * The last listing of each media directory, kept while the directory has not
 * changed. Every GET of `/comfy-media` used to read the directory and `stat`
 * ~3000 files, after every finished job.
 */
const listings = new Map<string, { readonly dirMtime: number; readonly builtAt: number; readonly items: readonly GalleryItem[] }>()

/**
 * How recent a file has to be, when the listing is built, to be checked again
 * at every call. A new file moves the directory's mtime when it is created,
 * not while it is written: a clip still being downloaded from ComfyUI, or
 * copied in by Openjutsu, is listed with the size it had then, and only its
 * own `stat` says it grew.
 */
const STILL_WRITING_MS = 5 * 60_000

/**
 * Whether the files that were still recent when the listing was built are
 * unchanged: same size and mtime, still there.
 */
async function stillSettled(
  outputDir: string,
  known: { readonly builtAt: number; readonly items: readonly GalleryItem[] },
): Promise<boolean> {
  const recent = known.items.filter(item => item.mtime > known.builtAt - STILL_WRITING_MS)
  const same = await mapWithConcurrency(recent, GALLERY_PROBE_CONCURRENCY, async (item) => {
    try {
      const info = await stat(join(outputDir, item.name))
      return info.size === item.size && info.mtimeMs === item.mtime
    } catch {
      return false
    }
  })
  return same.every(Boolean)
}

/**
 * Drop the kept listing, after a write this module made: the directory's
 * mtime would say so too, this only makes it certain.
 * @param outputDir - the media directory.
 */
function forgetListing(outputDir: string): void {
  listings.delete(outputDir)
}

/** Read the directory and probe every media file in it; see {@link listGallery}. */
async function readGallery(outputDir: string): Promise<GalleryItem[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(outputDir, { withFileTypes: true })
  } catch (error: unknown) {
    if (isMissing(error)) return []
    throw error
  }
  // A name starting with a dot is scratch an assembler is still writing
  // (montage, loop, seam, song): it gets its real name when it is done.
  const candidates = entries
    .filter(entry => entry.isFile() && !entry.name.startsWith('.') && safeBasename(entry.name) !== undefined)
    .map(entry => ({ name: entry.name, kind: kindOf(entry.name) }))
    .filter((entry): entry is { name: string; kind: MediaKind } => entry.kind !== undefined)

  const cache = probedIn(outputDir)
  const probed = await mapWithConcurrency(candidates, GALLERY_PROBE_CONCURRENCY, async ({ name }) => galleryItemOf(outputDir, name))
  const items = probed.filter((entry): entry is GalleryItem => entry !== undefined)
  // Files gone from the directory leave the cache with the listing.
  if (cache.size > items.length) {
    const present = new Set(items.map(item => item.name))
    for (const name of cache.keys()) if (!present.has(name)) cache.delete(name)
  }
  items.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
  return items
}

/**
 * The items already probed, by directory and name.
 *
 * The studio lists the gallery after every finished job and the listing
 * opened and read the header of every file each time (2776 files on
 * 2026-10-20). An item whose size and mtime have not moved is the same file:
 * only its `stat` is repeated, the header read is not.
 */
const probedByDir = new Map<string, Map<string, GalleryItem>>()

function probedIn(outputDir: string): Map<string, GalleryItem> {
  let cache = probedByDir.get(outputDir)
  if (cache === undefined) probedByDir.set(outputDir, cache = new Map())
  return cache
}

/**
 * One gallery entry, as the listing builds it: kind, size, mtime, pixel size
 * (and an MP4's length) and the tool its name declares.
 *
 * The one place an entry is made — the listing, an upload, and the host's
 * edits that answer with the file they wrote — so an entry never comes back
 * without its `tool`, or with an mtime rounded differently from the listing's.
 * The entry goes into the listing's cache: the next listing reads only its
 * `stat`.
 * @param outputDir - the validated media output directory.
 * @param name - a safe basename in it.
 * @param info - its `stat`, when the caller already has it.
 * @returns the entry, or undefined when the name is not gallery media; throws
 *   when the file is missing.
 */
export async function galleryItemOf(outputDir: string, name: string, info?: Stats): Promise<GalleryItem | undefined> {
  const kind = kindOf(name)
  if (kind === undefined) return undefined
  const path = join(outputDir, name)
  const stats = info ?? await stat(path)
  const cache = probedIn(outputDir)
  const cached = cache.get(name)
  if (cached !== undefined && cached.size === stats.size && cached.mtime === stats.mtimeMs) return cached
  const tool = toolOf(name)
  const pixels = await probePixels(path, kind)
  const item = {
    name,
    kind,
    size: stats.size,
    mtime: stats.mtimeMs,
    ...pixels,
    ...tool === undefined ? {} : { tool },
  } satisfies GalleryItem
  cache.set(name, item)
  return item
}

/**
 * Delete one produced file by basename, and everything filed about it.
 * Missing files are a no-op success.
 *
 * All the cleanup is here, so no caller can delete a file and leave half of
 * it behind (until 2026-11-07 the route did a second round of its own):
 * - the prompt a clip was written with, which outlives the job that wrote it;
 * - the canvas position — nothing else prunes `placed`, so a rect left behind
 *   outlives every project that could use it;
 * - the thumbnails;
 * - the note, then the description the chat remembers of the file. The note
 *   goes with `forgetNote` and only the in-memory copy with `forgetSeen`:
 *   `forgetSight` would amend the note a second time.
 * @param outputDir - the validated media output directory.
 * @param name - the requested basename.
 * @returns whether the name was a safe basename (false = caller should 400).
 */
export async function deleteGalleryItem(outputDir: string, name: string): Promise<boolean> {
  const safe = safeBasename(name)
  if (safe === undefined) return false
  try {
    await unlink(join(outputDir, safe))
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
  }
  forgetListing(outputDir)
  await Promise.all([
    forgetWrittenPrompt(safe),
    forgetPlacedItem(safe),
    forgetThumbs(safe),
    forgetNote(safe).then(() => { forgetSeen(safe) }),
  ])
  return true
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const RIFF_MAGIC = Buffer.from('RIFF', 'ascii')
const WEBP_WEBP = Buffer.from('WEBP', 'ascii')
const GIF87A_MAGIC = Buffer.from('GIF87a', 'ascii')
const GIF89A_MAGIC = Buffer.from('GIF89a', 'ascii')
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
/** The still formats a file's first bytes can say it is. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/**
 * The still format the leading bytes actually are, whatever the extension.
 * Generated `.webp` files on this deployment are PNGs, so every caller that
 * picks an encoder or a media type reads it here.
 * @param bytes - at least the first 12 bytes of the file.
 * @returns the media type, or undefined when it is not a still this studio reads.
 */
export function imageTypeOf(bytes: Uint8Array): ImageMediaType | undefined {
  const sniffed = sniffMedia(bytes)
  return sniffed !== undefined && sniffed.startsWith('image/') ? sniffed as ImageMediaType : undefined
}

/**
 * The clip container the leading bytes actually are.
 * @param bytes - at least the first 8 bytes of the file.
 * @returns mp4 for any ISO BMFF (mp4, mov), webm for Matroska, else undefined.
 */
export function videoTypeOf(bytes: Uint8Array): 'video/mp4' | 'video/webm' | undefined {
  const sniffed = sniffMedia(bytes)
  return sniffed === 'video/mp4' || sniffed === 'video/webm' ? sniffed : undefined
}

/** Largest cropped image the gallery will write over an existing still. */
export const MAX_CROP_BYTES = 12 * 1024 * 1024

/**
 * Replace one still with a cropped image. Only png/jpeg/webp stills; the
 * payload must match the file extension.
 * @param outputDir - the validated media output directory.
 * @param name - the requested basename.
 * @param bytes - the cropped image bytes.
 * @returns whether the write landed.
 */
export async function replaceGalleryImage(
  outputDir: string,
  name: string,
  bytes: Uint8Array,
): Promise<boolean> {
  const safe = safeBasename(name)
  if (safe === undefined || kindOf(safe) !== 'image') return false
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CROP_BYTES) return false
  const ext = safe.split('.').pop()?.toLowerCase() ?? ''
  if (!bytesMatchExt(bytes, ext)) return false
  let mode: number
  try {
    mode = (await stat(join(outputDir, safe))).mode & 0o777
  } catch (error: unknown) {
    if (isMissing(error)) return false
    throw error
  }
  // By rename, with the file's own permissions: written in place, a thumbnail
  // or a download reading the still meanwhile got half a crop.
  await writeFileAtomic(join(outputDir, safe), bytes, { mode })
  forgetListing(outputDir)
  return true
}

/**
 * The gallery extension a dropped file is stored under: its own, lowercased,
 * with `jpeg` spelled `jpg`. The upload and the message that refuses it must
 * agree on it.
 * @param filename - the client-declared name.
 * @returns the extension, without the dot.
 */
export function uploadExt(filename: string): string {
  const rawExt = filename.split('.').pop()?.toLowerCase() ?? ''
  return rawExt === 'jpeg' ? 'jpg' : rawExt
}

/** Bytes of the head kept for the signature check. */
const SIGNATURE_BYTES = 16

/** How a dropped file ended: written into the gallery, or refused. */
type UploadOutcome =
  | { readonly ok: true; readonly item: GalleryItem }
  /** The head that was read, so the caller can say *why* it was refused. */
  | { readonly ok: false; readonly head: Uint8Array }

/**
 * Write a dropped still, clip or song into the gallery as `upload-<id>.<ext>`,
 * streaming it to disk. Nothing is buffered whole, so the size a drop may have
 * is the free space on the media disk rather than the memory of this process.
 * @param outputDir - the validated media output directory.
 * @param filename - original client name, used only for the extension.
 * @param body - the request body, or any stream of the file's bytes.
 * @returns the new gallery item, or the head that was refused.
 */
export async function saveGalleryUploadStream(
  outputDir: string,
  filename: string,
  body: AsyncIterable<Uint8Array>,
): Promise<UploadOutcome> {
  const ext = uploadExt(filename)
  const kind = kindOf(`x.${ext}`)
  if (kind === undefined) return { ok: false, head: new Uint8Array(0) }
  await mkdir(outputDir, { recursive: true })
  const name = `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const path = join(outputDir, name)
  let head = Buffer.alloc(0)
  try {
    await pipeline(
      body,
      async function* (source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
        for await (const chunk of source) {
          const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          if (head.byteLength < SIGNATURE_BYTES) {
            head = Buffer.concat([head, buf.subarray(0, SIGNATURE_BYTES - head.byteLength)])
            // Every kind is signature-checked, not just stills: bytes accepted
            // on the extension alone come back out of the gallery as playable
            // media, and a clip with no readable dimensions reads as
            // upscalable. Checked on the head so a mistyped file is refused
            // before its gigabytes are written, not after.
            if (head.byteLength === SIGNATURE_BYTES && !bytesMatchExt(head, ext)) {
              throw new UploadRefusedError()
            }
          }
          yield buf
        }
      },
      createWriteStream(path),
    )
  } catch (error: unknown) {
    await discardUpload(path)
    if (error instanceof UploadRefusedError) return { ok: false, head }
    throw error
  }
  // A file too short to carry a signature never reached the check above.
  if (head.byteLength === 0 || !bytesMatchExt(head, ext)) {
    await discardUpload(path)
    return { ok: false, head }
  }
  // The same entry the listing will show, mtime included: the upload used to
  // answer with a truncated mtime, so the tile moved when the list came back.
  const item = await galleryItemOf(outputDir, name)
  if (item === undefined) throw new Error(message('upload.noKind', { name }))
  forgetListing(outputDir)
  return { ok: true, item }
}

/** A body whose bytes do not match the extension it was dropped under. */
class UploadRefusedError extends Error {
  constructor() {
    super('upload refused')
    this.name = 'UploadRefusedError'
  }
}

/** Remove a half-written upload, ignoring a file that never got created. */
async function discardUpload(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
  }
}

/** Bytes read first: enough for every still and a faststart clip's `moov` head. */
const HEADER_FIRST = 64 * 1024
/** Bytes read when the first window held no size. */
const HEADER = 512 * 1024
/**
 * The 2x upscale target for a source, capped at the graph ceiling for its kind.
 * @param width - source pixel width.
 * @param height - source pixel height.
 * @param kind - image or video, which have different ceilings.
 * @returns the longest side the workflow should produce.
 */
export function upscaleTargetFor(
  width: number,
  height: number,
  kind: 'image' | 'video' = 'image',
): number {
  const ceiling = kind === 'video' ? UPSCALE_VIDEO_MAX_SIDE : UPSCALE_MAX_SIDE
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  /*
   * A still whose 2x reaches 4K (within 5%) is upscaled to 4K exactly, the
   * short side to 2160: the edit graph's 32-pixel grid turns 1080x1920 into
   * 1056x1888, whose 2x was 2112x3776, and a 1440p still doubled overshot to
   * 2304x4096 (asked 2026-10-17: "fai preciso 3840x2160"). A smaller still
   * keeps the 2x cap, which is there for quality.
   */
  if (kind === 'image' && short * 2 >= 2160 * 0.95) {
    // Also from above: a 1440p still doubled is 2304x4096, past the 4K frame
    // the job then crops to (snap-size.ts fourKFrame); ask for 4K directly.
    return Math.min(Math.ceil(2160 * long / short), ceiling)
  }
  return Math.min(long * 2, ceiling)
}

/**
 * The long side an upscale asked for a given short side should produce,
 * capped at the graph ceiling for its kind (the user's choice from the
 * tile's menu, 2026-10-17; without one the job keeps upscaleTargetFor).
 * @param width - source pixel width.
 * @param height - source pixel height.
 * @param short - the short side to arrive at.
 * @param kind - image or video.
 */
export function upscaleLongFor(width: number, height: number, short: number, kind: 'image' | 'video' = 'image'): number {
  const ceiling = kind === 'video' ? UPSCALE_VIDEO_MAX_SIDE : UPSCALE_MAX_SIDE
  return Math.min(Math.ceil(short * Math.max(width, height) / Math.min(width, height)), ceiling)
}

/** Largest `moov` box read from past the header; a bigger one leaves the clip unmeasured. */
const MOOV_MAX = 64 * 1024 * 1024

/** Top-level MP4 boxes visited looking for `moov` before giving up. */
const TOP_BOXES_MAX = 64

/**
 * Read width/height from a still or clip header, and an MP4/MOV clip's
 * length. Missing or unknown containers yield an empty object so the inventory
 * still lists the file.
 *
 * An MP4 or MOV written without faststart — what phones and desktop editors
 * export — keeps its `moov` box after the media data, far past the header, so
 * a 1080x1920 upload measured as unknown and showed no quality badge. When the
 * header is ISO BMFF but holds no size, the top-level boxes are walked on disk
 * to that `moov`.
 * @param path - absolute media path.
 * @param kind - image or video.
 * @returns pixel size when known, plus `duration` in seconds for an MP4/MOV clip.
 */
export async function probePixels(
  path: string,
  kind: MediaKind,
): Promise<{ width: number; height: number; duration?: number } | Record<string, never>> {
  if (kind === 'audio') return {}
  let fd: Awaited<ReturnType<typeof open>>
  try {
    fd = await open(path, 'r')
  } catch {
    return {}
  }
  try {
    // A PNG states its size in its first 24 bytes; reading 512 KiB of every
    // file was 1.4 GB per listing. The wide window stays for what needs it.
    let header = Buffer.alloc(HEADER_FIRST)
    let { bytesRead } = await fd.read(header, 0, HEADER_FIRST, 0)
    const sizeIn = (bytes: Buffer): ReturnType<typeof videoSizeOf> =>
      kind === 'image' ? imageSizeOf(bytes) : videoSizeOf(bytes)
    let size = sizeIn(header.subarray(0, bytesRead))
    if (size === undefined && bytesRead === HEADER_FIRST) {
      // The wide window carries on from where the first one stopped: the
      // first 64 KiB are already in hand and are not read again.
      const wide = Buffer.alloc(HEADER)
      header.copy(wide, 0, 0, HEADER_FIRST)
      header = wide
      bytesRead = HEADER_FIRST + (await fd.read(header, HEADER_FIRST, HEADER - HEADER_FIRST, HEADER_FIRST)).bytesRead
      size = sizeIn(header.subarray(0, bytesRead))
    }
    if (size === undefined && kind === 'video' && bytesRead >= 8 && header.toString('ascii', 4, 8) === 'ftyp') {
      size = await trailingMoovSizeOf(fd, (await fd.stat()).size)
    }
    return size ?? {}
  } finally {
    await fd.close()
  }
}

/**
 * Pixel size of an MP4/MOV whose `moov` box lies anywhere in the file: walks
 * the top-level boxes by their headers alone, skipping the media data, and
 * reads only the `moov` box itself.
 * @param fd - the open clip.
 * @param fileSize - the clip's size in bytes; a box of size 0 runs to it.
 * @returns the size, or undefined when no readable `moov` is found.
 */
async function trailingMoovSizeOf(
  fd: Awaited<ReturnType<typeof open>>,
  fileSize: number,
): Promise<Mp4Info | undefined> {
  const head = Buffer.alloc(16)
  let offset = 0
  for (let box = 0; box < TOP_BOXES_MAX && offset + 8 <= fileSize; box++) {
    const { bytesRead } = await fd.read(head, 0, 16, offset)
    if (bytesRead < 8) return undefined
    let size = head.readUInt32BE(0)
    if (size === 1) {
      if (bytesRead < 16) return undefined
      size = Number(head.readBigUInt64BE(8))
    } else if (size === 0) {
      size = fileSize - offset
    }
    if (size < 8) return undefined
    if (head.toString('ascii', 4, 8) === 'moov') {
      if (size > MOOV_MAX) return undefined
      const moov = Buffer.alloc(size)
      const read = await fd.read(moov, 0, size, offset)
      return mp4SizeOf(moov.subarray(0, read.bytesRead))
    }
    offset += size
  }
  return undefined
}

/**
 * Pixel size of a clip already in memory.
 *
 * Handed the whole file, an MP4 whose `moov` sits after the media data is
 * measured too: the top-level boxes are walked by their sizes. Handed only
 * the head, a clip written without faststart reports nothing.
 * @param bytes - the clip, or its leading bytes.
 * @returns width/height (and the length of an MP4/MOV) when the container is recognised.
 */
export function pixelsOfVideoBytes(bytes: Uint8Array): { width: number; height: number; duration?: number } | undefined {
  return videoSizeOf(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

function imageSizeOf(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_MAGIC)) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return jpegSizeOf(buf)
  }
  if (buf.length >= 30 && buf.subarray(0, 4).equals(RIFF_MAGIC) && buf.subarray(8, 12).equals(WEBP_WEBP)) {
    return webpSizeOf(buf)
  }
  if (buf.length >= 10 && (buf.subarray(0, 6).equals(GIF87A_MAGIC) || buf.subarray(0, 6).equals(GIF89A_MAGIC))) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  return undefined
}

function jpegSizeOf(buf: Buffer): { width: number; height: number } | undefined {
  let offset = 2
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) break
    const marker = buf[offset + 1]
    if (marker === undefined) break
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2
      continue
    }
    const length = buf.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xc3 && offset + 8 < buf.length) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return undefined
}

function webpSizeOf(buf: Buffer): { width: number; height: number } | undefined {
  const chunk = buf.subarray(12, 16).toString('ascii')
  if (chunk === 'VP8 ' && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X' && buf.length >= 30) {
    const w0 = buf[24]
    const w1 = buf[25]
    const w2 = buf[26]
    const h0 = buf[27]
    const h1 = buf[28]
    const h2 = buf[29]
    if (w0 === undefined || w1 === undefined || w2 === undefined) return undefined
    if (h0 === undefined || h1 === undefined || h2 === undefined) return undefined
    return {
      width: 1 + w0 + (w1 << 8) + (w2 << 16),
      height: 1 + h0 + (h1 << 8) + (h2 << 16),
    }
  }
  return undefined
}

function videoSizeOf(buf: Buffer): { width: number; height: number; duration?: number } | undefined {
  if (buf.length >= 8 && buf.subarray(4, 8).toString('ascii') === 'ftyp') return mp4SizeOf(buf)
  if (buf.length >= 4 && buf.subarray(0, 4).equals(EBML_MAGIC)) return webmSizeOf(buf)
  return undefined
}

/** EBML master elements on the path from the file root down to the video track. */
const EBML_MASTERS = new Set([0x18538067, 0x1654ae6b, 0xae, 0xe0])

/** EBML leaf holding the coded pixel width. */
const EBML_PIXEL_WIDTH = 0xb0

/** EBML leaf holding the coded pixel height. */
const EBML_PIXEL_HEIGHT = 0xba

/**
 * Read one EBML variable-length integer.
 * @param buf - the buffer to read from.
 * @param offset - where the integer starts.
 * @param keepMarker - true for an element id, whose length marker is part of
 *   its value; false for a size, where the marker is stripped.
 * @returns the value and its encoded byte length, or undefined when the bytes
 *   run out or the leading byte is not a valid marker.
 */
function ebmlInt(buf: Buffer, offset: number, keepMarker: boolean): { value: number; length: number } | undefined {
  const first = buf[offset]
  if (first === undefined || first === 0) return undefined
  let length = 1
  for (let mask = 0x80; (first & mask) === 0; mask >>= 1) length++
  if (length > 8 || offset + length > buf.length) return undefined
  let value = keepMarker ? first : first & (0xff >> length)
  for (let index = 1; index < length; index++) value = value * 256 + (buf[offset + index] ?? 0)
  return { value, length }
}

/**
 * Pixel size of a Matroska/WebM clip, by walking the element tree down to the
 * video track. Without this a `.webm` measured as unknown, which let it past
 * the upscale ceiling guard and onto a run that shrank it.
 * @param buf - the clip's leading bytes.
 * @returns pixel size when both dimensions are present in the read window.
 */
function webmSizeOf(buf: Buffer): { width: number; height: number } | undefined {
  let width: number | undefined
  let height: number | undefined
  let offset = 0
  while (offset < buf.length) {
    const id = ebmlInt(buf, offset, true)
    if (id === undefined) break
    const size = ebmlInt(buf, offset + id.length, false)
    if (size === undefined) break
    const body = offset + id.length + size.length
    const end = Math.min(body + size.value, buf.length)
    if (EBML_MASTERS.has(id.value)) {
      const nested = webmSizeOf(buf.subarray(body, end))
      if (nested !== undefined) return nested
    } else if (id.value === EBML_PIXEL_WIDTH || id.value === EBML_PIXEL_HEIGHT) {
      let value = 0
      for (let index = body; index < end; index++) value = value * 256 + (buf[index] ?? 0)
      if (id.value === EBML_PIXEL_WIDTH) width ??= value
      else height ??= value
    }
    if (end <= offset) break
    offset = end
  }
  return width === undefined || height === undefined ? undefined : { width, height }
}

/** What the `moov` box of an MP4/MOV tells about the clip: pixel size, and length when `mvhd` is readable. */
interface Mp4Info { width: number; height: number; duration?: number }

function mp4SizeOf(buf: Buffer): Mp4Info | undefined {
  const found: { width?: number; height?: number; duration?: number } = {}
  walkMp4(buf, found)
  if (found.width === undefined || found.height === undefined) return undefined
  return found.duration === undefined
    ? { width: found.width, height: found.height }
    : { width: found.width, height: found.height, duration: found.duration }
}

/**
 * Walk the boxes on the path to the tracks, keeping the first video track's
 * size (`tkhd`) and the movie length (`mvhd`, duration over timescale).
 * @param buf - a run of boxes.
 * @param found - filled in place; a value already set is kept.
 */
function walkMp4(buf: Buffer, found: { width?: number; height?: number; duration?: number }): void {
  let offset = 0
  while (offset + 8 <= buf.length) {
    let size = buf.readUInt32BE(offset)
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii')
    let header = 8
    if (size === 1 && offset + 16 <= buf.length) {
      size = Number(buf.readBigUInt64BE(offset + 8))
      header = 16
    }
    if (size < header) break
    if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl') {
      walkMp4(buf.subarray(offset + header, offset + size), found)
    }
    if (type === 'mvhd' && found.duration === undefined) {
      const body = offset + header
      const version = buf[body]
      const end = version === 1 ? body + 32 : body + 20
      if (end <= buf.length) {
        const timescale = buf.readUInt32BE(version === 1 ? body + 20 : body + 12)
        const length = version === 1 ? Number(buf.readBigUInt64BE(body + 24)) : buf.readUInt32BE(body + 16)
        if (timescale > 0 && length > 0) found.duration = length / timescale
      }
    }
    if (type === 'tkhd' && found.width === undefined && offset + header + 84 <= buf.length) {
      const version = buf[offset + header]
      const dim = version === 1 ? offset + header + 88 : offset + header + 76
      if (dim + 8 <= buf.length) {
        const width = buf.readUInt32BE(dim) >> 16
        const height = buf.readUInt32BE(dim + 4) >> 16
        if (width > 0 && height > 0) {
          found.width = width
          found.height = height
        }
      }
    }
    offset += size
  }
}

/**
 * Whether the leading bytes are the container signature the extension
 * promises. Every gallery extension is covered: a caller that accepts a file
 * on the extension alone would let arbitrary bytes in as playable media.
 * @param bytes - the uploaded bytes.
 * @param ext - the normalised lowercase extension, without the dot.
 * @returns true when the signature matches.
 */
export function bytesMatchExt(bytes: Uint8Array, ext: string): boolean {
  const sniffed = sniffMedia(bytes)
  if (sniffed === undefined) return false
  // ISO base media (mp4, mov, m4a) carries `ftyp` at offset 4, after the box
  // size, and sniffs as mp4 whatever the extension: a .mov is QuickTime and an
  // .m4a is audio, ISO BMFF cousins the gallery reads like mp4.
  if (ext === 'mp4' || ext === 'mov' || ext === 'm4a') return sniffed === 'video/mp4'
  return MEDIA_EXTENSIONS[ext]?.mime === sniffed
}

/** True when the filesystem error is ENOENT. */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
