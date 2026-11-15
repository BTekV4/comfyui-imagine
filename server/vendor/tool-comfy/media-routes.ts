/**
 * The media routes: `/comfy-media` (gallery listing, upload, one file with
 * ranges and thumbnails, crop, delete) and `/comfy-zip` (several files as one
 * archive).
 *
 * Split out of `index.ts` on 2026-11-07.
 * @module tool-comfy/media-routes
 */

import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImagineHost } from '../../src/host.ts'
import { message } from '../../src/messages.ts'
import { allowOnly, decodePath, HttpError, rangeOf, readBody, readObject, restOf, sendJson } from '../../src/route-kit.ts'
import {
  AUDIO_EXTENSIONS, bytesMatchExt, deleteGalleryItem, IMAGE_EXTENSIONS, kindOf, listGallery, MAX_CROP_BYTES, mimeOf,
  replaceGalleryImage, safeBasename, saveGalleryUploadStream, uploadExt, VIDEO_EXTENSIONS,
} from './gallery.ts'
import { writeJsonTagged } from '../../src/route-kit.ts'
import { forgetSight, lookSoon } from './imagine-sight.ts'
import { parseZipNames, streamMediaZip } from './media-zip.ts'
import { canThumb, forgetThumbs, thumbnailOf, thumbWidthFor } from './media-thumbs.ts'

/**
 * Say why a crop could not be written. Without a body the browser only sees a
 * bare 400, and the viewer has nothing to show the user.
 * @param name - the still being replaced.
 * @param byteLength - the size of the rejected payload.
 * @returns a sentence for the user.
 */
function cropRejection(name: string, byteLength: number): string {
  if (byteLength > MAX_CROP_BYTES) {
    return message('crop.tooLarge', { max: Math.round(MAX_CROP_BYTES / (1024 * 1024)) })
  }
  if (kindOf(name) !== 'image') return message('crop.imagesOnly')
  return message('crop.notSaved')
}

/**
 * Say why an upload was refused, naming the file and the accepted formats.
 * `unsupported media` alone leaves the user guessing which of several files
 * was the problem, and what would have worked.
 * @param filename - the client-declared name.
 * @param bytes - the bytes that were read.
 * @returns a sentence for the user.
 */
function uploadRejection(filename: string, bytes: Uint8Array): string {
  const accepted = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS].join(', ')
  const ext = uploadExt(filename)
  // The extension comes first: a file refused on its name alone was never
  // read, so its head is empty and would otherwise read as "è vuoto".
  if (kindOf(`x.${ext}`) === undefined) {
    return message('upload.unsupportedFormat', { file: filename, accepted })
  }
  if (bytes.byteLength === 0) return message('upload.empty', { file: filename })
  if (!bytesMatchExt(bytes, ext)) {
    return message('upload.contentMismatch', { file: filename, ext })
  }
  return message('upload.rejected', { file: filename })
}

/**
 * Serve the Imagine inventory at GET /comfy-media (JSON), and take an upload
 * on POST. Other methods 405.
 * @param req - incoming request.
 * @param res - outgoing response.
 * @param outputDir - the validated media output directory.
 * @param eyes - the context an upload is looked at with.
 */
async function handleGalleryIndex(
  req: IncomingMessage,
  res: ServerResponse,
  outputDir: string,
  /** Who looks at an upload on arrival; absent, nothing is looked at. */
  eyes?: ImagineHost,
): Promise<void> {
  if (req.method === 'POST') {
    // A header the client escaped wrong is not a reason to fail the upload:
    // the file is still a file, under a name nobody chose.
    const filename = decodePath(String(req.headers['x-filename'] ?? 'upload.bin')) ?? 'upload.bin'
    // Streamed straight to the media disk: a dropped clip is never held whole
    // in memory, so there is no size a drop has to stay under.
    const outcome = await saveGalleryUploadStream(outputDir, filename, req)
    if (!outcome.ok) {
      sendJson(res, 400, { error: uploadRejection(filename, outcome.head), file: filename })
      return
    }
    const item = outcome.item
    // Seen on arrival, not when a line asks: by the time the chat is told
    // "questa foto" the description is usually already on file. The upload
    // does not wait for the look. A clip is read through one of its own
    // frames (2026-10-31), so an uploaded video gets a description too; a
    // track has nothing to look at.
    if ((item.kind === 'image' || item.kind === 'video') && eyes !== undefined) {
      lookSoon(eyes, outputDir, [item.name])
    }
    sendJson(res, 201, item)
    return
  }
  if (!allowOnly(req, res, 'GET', 'HEAD', 'POST')) return
  // The listing is sorted, so the hash covers a stable order: the same files
  // always serialize to the same bytes.
  writeJsonTagged('gallery', req, res, req.method, JSON.stringify({ items: await listGallery(outputDir) }))
}

/**
 * The largest `{ names }` list a zip request may send: basenames only, at
 * most `MAX_ZIP_ENTRIES` of them (until 2026-11-07 it accepted 80 MB).
 */
const ZIP_BODY_BYTES = 1024 * 1024

/**
 * The `/comfy-zip` route handler: POST a `{ names }` list, get one archive.
 *
 * POST rather than GET because the list is the request: a selection of any
 * size does not belong in a URL, and the archive is not a cacheable resource.
 * @param outputDir - the validated media output directory.
 * @returns the route handler.
 */
export function zipHandler(outputDir: string): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!allowOnly(req, res, 'POST')) return
    const body = await readObject(req, ZIP_BODY_BYTES)
    const names = parseZipNames(body)
    if (names === undefined) {
      sendJson(res, 400, { error: message('upload.invalidList') })
      return
    }
    await streamMediaZip(outputDir, names, res)
  }
}

/**
 * The `/comfy-media` route handler: lists the gallery at the prefix, serves
 * one file by basename (with single-range support so browsers can seek
 * generated videos), and deletes one file on DELETE.
 * @param outputDir - the validated media output directory.
 * @param eyes - the context an uploaded file is looked at with; absent,
 *   nothing is looked at.
 * @returns the route handler.
 */
export function mediaHandler(
  outputDir: string,
  eyes?: ImagineHost,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const name = restOf(req, res, '/comfy-media')
    if (name === undefined) return
    if (name.length === 0) {
      await handleGalleryIndex(req, res, outputDir, eyes)
      return
    }
    if (safeBasename(name) === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.method === 'DELETE') {
      // The name is already a safe basename, so the delete always goes ahead;
      // everything filed about the file goes with it (see deleteGalleryItem).
      await deleteGalleryItem(outputDir, name)
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'PUT') {
      let bytes: Buffer
      try {
        // One byte past the crop ceiling is enough to know it is refused.
        bytes = await readBody(req, MAX_CROP_BYTES + 1)
      } catch (error: unknown) {
        if (!(error instanceof HttpError) || error.status !== 413) throw error
        sendJson(res, 413, { error: cropRejection(name, MAX_CROP_BYTES + 1) })
        return
      }
      if (await replaceGalleryImage(outputDir, name, bytes)) {
        // A crop is the one thing that rewrites a still under a name that is
        // already spoken for, so the description the chat remembers of it is
        // now of the picture before the crop.
        await Promise.all([forgetSight(name), forgetThumbs(name)])
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 400, { error: cropRejection(name, bytes.byteLength) })
      return
    }
    if (!allowOnly(req, res, 'GET', 'HEAD', 'PUT', 'DELETE')) return
    const source = join(outputDir, name)
    // `?thumb=<px>` asks for the board's small copy. One that cannot be cut
    // (ffmpeg missing or failing on the file) falls through to the original,
    // so the tile still draws, only heavier.
    const thumbWidth = thumbWidthFor(url.searchParams.get('thumb'))
    const thumb = thumbWidth !== undefined && canThumb(name)
      ? await thumbnailOf(source, name, thumbWidth)
      : undefined
    const file = thumb ?? source
    let fd: Awaited<ReturnType<typeof open>>
    try {
      fd = await open(file, 'r')
    } catch {
      res.writeHead(404)
      res.end()
      return
    }
    // Once a stream holds the descriptor it closes it; until then this does.
    let streaming = false
    try {
      const stat = await fd.stat()
      const type = (thumb !== undefined ? 'image/webp' : mimeOf(name)) ?? 'application/octet-stream'
      // Generated media is written once under a name nobody reuses, but a crop
      // does replace one in place, so the validator covers size and mtime
      // rather than the name. Without it every visit re-downloaded the whole
      // canvas: `no-cache` asks the browser to revalidate, and only now does
      // revalidating cost a 304 instead of the file.
      const tag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`
      if (req.headers['if-none-match'] === tag) {
        res.writeHead(304, { etag: tag, 'cache-control': 'no-cache' })
        res.end()
        return
      }
      const range = rangeOf(req.headers.range, stat.size)
      if (range === 'invalid') {
        res.writeHead(416, { 'content-range': `bytes */${String(stat.size)}` })
        res.end()
        return
      }
      if (range !== undefined) {
        const { start, end } = range
        res.writeHead(206, {
          'content-type': type,
          'content-length': end - start + 1,
          'content-range': `bytes ${String(start)}-${String(end)}/${String(stat.size)}`,
          'accept-ranges': 'bytes',
          'cache-control': 'no-cache',
          'last-modified': stat.mtime.toUTCString(),
          etag: tag,
        })
        // The stream ends the response when it drains; ending it here
        // would cut the body off at zero bytes.
        if (req.method === 'GET') {
          sendFile(res, fd, start, end)
          streaming = true
        } else res.end()
        return
      }
      res.writeHead(200, {
        'content-type': type,
        'content-length': stat.size,
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
        'last-modified': stat.mtime.toUTCString(),
        etag: tag,
      })
      if (req.method === 'GET') {
        sendFile(res, fd)
        streaming = true
      } else res.end()
    } finally {
      if (!streaming) await fd.close()
    }
  }
}

/**
 * Stream a file, or one byte range of it, to the response.
 *
 * Both the whole-file and the range path go through here. The range path used
 * to `Buffer.alloc` the whole interval, so a `Range: bytes=0-` — which is a
 * range over the entire file, and what a video element opens with — held the
 * file in memory for the length of the request. Aborting the response destroys
 * the stream: without that, every cancelled tile left its descriptor open.
 * @param res - the response to write to.
 * @param fd - the open media file; the stream closes it when it ends.
 * @param start - first byte to send; omitted sends from the beginning.
 * @param end - last byte to send, inclusive; omitted sends to the end.
 */
function sendFile(res: ServerResponse, fd: FileHandle, start?: number, end?: number): void {
  // Off the descriptor the handler already opened and measured: reopening by
  // path read a file that a crop could have replaced in between.
  const stream = fd.createReadStream(start === undefined ? {} : { start, end })
  stream.on('error', () => { res.end() })
  res.on('close', () => { stream.destroy() })
  stream.pipe(res)
}
