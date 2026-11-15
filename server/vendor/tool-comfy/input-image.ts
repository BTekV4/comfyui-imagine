/**
 * Resolve a job's input image or clip to bytes and a media type.
 *
 * The studio names its inputs by path under the media directory.
 * @module tool-comfy/input-image
 */

import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { ComfyError } from '../comfyui/index.ts'
import { imageTypeOf, videoTypeOf, type ImageMediaType } from './gallery.ts'

/** Resolved input image for the ComfyUI upload. */
export interface ResolvedInputImage {
  readonly bytes: Uint8Array
  /** Media type sniffed from the magic bytes (PNG/JPEG/WebP/GIF). */
  readonly mediaType: ImageMediaType
  /** File name presented to the ComfyUI loader. */
  readonly name: string
}

/**
 * Read one input file named by path, and sniff its type from the bytes.
 *
 * Whole in memory: the ComfyUI upload (`comfy.uploadImage`/`uploadVideo`)
 * takes bytes. A streamed upload would need the client to accept a stream.
 * @param input - the raw parameter, `{ path }`.
 * @param cwd - base for a relative path; the process directory when omitted.
 * @param what - `image` or `video`, for the error messages.
 * @param sniff - the media type of the bytes, or undefined when unsupported.
 * @param supported - how the error names the accepted formats.
 * @returns the bytes, the type and the upload name.
 */
async function readInput<T extends string>(
  input: { path?: string },
  cwd: string | undefined,
  what: 'image' | 'video',
  sniff: (data: Uint8Array) => T | undefined,
  supported: string,
): Promise<{ readonly bytes: Uint8Array; readonly mediaType: T; readonly name: string }> {
  const path = input.path
  if (path === undefined || path.length === 0) {
    throw new ComfyError(`${what} requires a path`, 'COMFY_INPUT_IMAGE_INVALID')
  }
  const absolute = isAbsolute(path) ? path : resolve(cwd ?? '.', path)
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(absolute))
  } catch (error: unknown) {
    throw new ComfyError(`cannot read input ${what} at ${path}`, 'COMFY_INPUT_IMAGE_INVALID', { cause: error })
  }
  const mediaType = sniff(bytes)
  if (mediaType === undefined) {
    throw new ComfyError(`input ${what} is not a supported ${supported}`, 'COMFY_INPUT_IMAGE_INVALID')
  }
  return { bytes, mediaType, name: basename(path) }
}

/**
 * Resolve the job input.
 * @param input - the raw `image` parameter, `{ path }`.
 * @param cwd - base for a relative path; the process directory when omitted.
 * @returns the resolved bytes, type, and upload name.
 */
export async function resolveInputImage(
  input: { path?: string },
  cwd?: string,
): Promise<ResolvedInputImage> {
  return readInput(input, cwd, 'image', imageTypeOf, 'PNG/JPEG/WebP/GIF')
}

/** Resolved input video for the ComfyUI upload. */
export interface ResolvedInputVideo {
  readonly bytes: Uint8Array
  readonly mediaType: 'video/mp4' | 'video/webm'
  readonly name: string
}

/**
 * Resolve a tool-provided input video from a workspace path.
 *
 * ISO base media (mp4 and .mov QuickTime) share the `ftyp` box at offset 4;
 * the upload keeps the file's own `.mov` name, so the node reads it like mp4.
 * @param input - the raw `video` parameter (`{ path }`).
 * @param cwd - base for a relative path; the process directory when omitted.
 * @returns the resolved bytes, type, and upload name.
 */
export async function resolveInputVideo(
  input: { path?: string },
  cwd?: string,
): Promise<ResolvedInputVideo> {
  return readInput(input, cwd, 'video', videoTypeOf, 'MP4/WebM')
}
