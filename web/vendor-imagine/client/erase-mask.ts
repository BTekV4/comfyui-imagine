/**
 * The mask the masked removal paints, from the box the grounding found.
 *
 * IOPaint fills the white part of the mask and leaves the rest of the photo
 * alone, so the mask decides how much is rebuilt. A box that stops exactly on
 * the edge of a printed mark leaves the anti-aliased ring around it in the
 * picture — the "halo" the eraser is known for — so the box is grown by
 * {@link grownRegion} and its edge is blurred before it is handed over: the
 * fill meets the surroundings over a few pixels instead of on a hard line.
 *
 * The mask is written at the photo's own pixel size, which is what IOPaint
 * requires; a photo whose size the gallery did not read is measured by
 * loading it, rather than assumed to be square.
 * @module erase-mask
 */

import { ERASE_FEATHER, grownRegion } from '../../../shared/imagine-grounding.ts'
import type { ImagineRegion } from '../../../shared/imagine-types.ts'
import { mediaUrlOf } from './gallery-api.ts'

/** What the mask needs of the photo. */
export interface MaskTarget {
  readonly name: string
  readonly width?: number
  readonly height?: number
}

/**
 * The photo's own pixel size, read off the picture when the gallery has none.
 * @param name - the gallery file.
 * @returns the size, or undefined when the picture cannot be loaded.
 */
async function naturalSize(name: string): Promise<{ readonly width: number; readonly height: number } | undefined> {
  return await new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      resolve(image.naturalWidth > 0 && image.naturalHeight > 0
        ? { width: image.naturalWidth, height: image.naturalHeight }
        : undefined)
    }
    image.onerror = () => { resolve(undefined) }
    image.src = mediaUrlOf(name)
  })
}

/**
 * Draw the removal's mask: a grown, softened white box on black.
 * @param target - the photo and its pixel size, when known.
 * @param region - the box the grounding found, in fractions of the photo.
 * @returns the mask as a PNG data URL, or undefined when the photo cannot be
 *   measured.
 */
export async function removalMask(target: MaskTarget, region: ImagineRegion): Promise<string | undefined> {
  const size = target.width !== undefined && target.height !== undefined && target.width > 0 && target.height > 0
    ? { width: target.width, height: target.height }
    : await naturalSize(target.name)
  if (size === undefined) return undefined
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (ctx === null) return undefined
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size.width, size.height)
  const box = grownRegion(region)
  const blur = Math.max(2, Math.round(Math.min(size.width, size.height) * ERASE_FEATHER))
  /*
   * The box is drawn past the canvas on every side by the blur radius: a
   * soft edge that falls inside the frame would leave a grey rim where the
   * mark is closest to the border, and the fill would nibble the edge of the
   * photo.
   */
  ctx.filter = `blur(${String(blur)}px)`
  ctx.fillStyle = '#fff'
  ctx.fillRect(
    box.x * size.width - blur,
    box.y * size.height - blur,
    box.w * size.width + blur * 2,
    box.h * size.height + blur * 2,
  )
  return canvas.toDataURL('image/png')
}
