/**
 * Masks for the MCP tools that change a zone of a photo: Precise edit and
 * Remove object take one PNG at the photo's own size, white where to act.
 *
 * The page builds it on a canvas (`joinedMask` in segments-api.ts); the MCP
 * server has no canvas, so the few PNG operations it needs are here, on
 * `node:zlib` alone: read a segment's mask, join several (the lighter pixel
 * wins, as the page's `lighten`), and draw a rectangle.
 *
 * Only what the studio writes is read: 8-bit, non-interlaced PNGs (the
 * Segments node saves greyscale masks). Anything else is refused with a reason
 * rather than misread.
 * @module mcp/masks
 */
import { crc32, deflateSync, inflateSync } from 'node:zlib'

/** A mask: one byte per pixel, 0 = keep, 255 = act. */
export interface Mask {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

/** A zone in fractions of the photo, as the studio's region. */
export interface Fractions {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Bytes per pixel of each 8-bit colour type. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 }

/**
 * Read a PNG into a mask: the first channel of each pixel (grey, or red).
 * @param png - the file's bytes.
 * @returns the mask.
 */
export function readMask(png: Uint8Array): Mask {
  const bytes = Buffer.from(png)
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat: Buffer[] = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      const colour = body[9] ?? -1
      const interlace = body[12]
      if (depth !== 8 || interlace !== 0 || CHANNELS[colour] === undefined) {
        throw new Error(`unsupported PNG (depth ${String(depth)}, colour type ${String(colour)}, interlace ${String(interlace)})`)
      }
      channels = CHANNELS[colour]
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (width === 0 || height === 0 || channels === 0) throw new Error('PNG without a header')
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length < height * (stride + 1)) throw new Error('PNG data is short')
  const previous = new Uint8Array(stride)
  const current = new Uint8Array(stride)
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1)
    const filter = raw[row]
    for (let i = 0; i < stride; i++) {
      const byte = raw[row + 1 + i] ?? 0
      const left = i >= channels ? current[i - channels] ?? 0 : 0
      const up = previous[i] ?? 0
      const corner = i >= channels ? previous[i - channels] ?? 0 : 0
      let value: number
      switch (filter) {
        case 0: value = byte; break
        case 1: value = byte + left; break
        case 2: value = byte + up; break
        case 3: value = byte + ((left + up) >> 1); break
        case 4: {
          const p = left + up - corner
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - corner)
          value = byte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : corner)
          break
        }
        default: throw new Error(`unknown PNG filter ${String(filter)}`)
      }
      current[i] = value & 0xff
    }
    for (let x = 0; x < width; x++) data[y * width + x] = current[x * channels] ?? 0
    previous.set(current)
  }
  return { width, height, data }
}

/**
 * One PNG chunk: length, type, body, CRC.
 * @param type - four letters.
 * @param body - the chunk's data.
 * @returns the bytes.
 */
function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0)
  return Buffer.concat([head, body, tail])
}

/**
 * Write a mask as an 8-bit greyscale PNG.
 * @param mask - the mask.
 * @returns the file's bytes.
 */
export function writeMask(mask: Mask): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(mask.width, 0)
  header.writeUInt32BE(mask.height, 4)
  header[8] = 8
  header[9] = 0
  const raw = Buffer.alloc(mask.height * (mask.width + 1))
  for (let y = 0; y < mask.height; y++) {
    raw[y * (mask.width + 1)] = 0
    raw.set(mask.data.subarray(y * mask.width, (y + 1) * mask.width), y * (mask.width + 1) + 1)
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/**
 * Several masks as one: the lighter pixel wins, so every chosen segment is in.
 * @param masks - masks of the same photo, all at its size.
 * @returns the joined mask.
 */
export function joinMasks(masks: readonly Mask[]): Mask {
  const first = masks[0]
  if (first === undefined) throw new Error('no mask to join')
  const data = new Uint8Array(first.width * first.height)
  for (const mask of masks) {
    if (mask.width !== first.width || mask.height !== first.height) {
      throw new Error(`masks of different sizes (${String(first.width)}x${String(first.height)} and ${String(mask.width)}x${String(mask.height)})`)
    }
    for (let i = 0; i < data.length; i++) data[i] = Math.max(data[i] ?? 0, mask.data[i] ?? 0)
  }
  return { width: first.width, height: first.height, data }
}

/**
 * Grow a mask by `radius` pixels in every direction (a square max filter, run
 * as two passes). LaMa fills a zone from its border: a mask that hugs the
 * object rebuilds the same shape (2026-11-15: a lighthouse cut out exactly
 * came back as a dark tower), while a margin around it lets the background
 * in — what the brush in the page does without anyone thinking about it.
 * @param mask - the mask.
 * @param radius - how far to grow, in pixels.
 * @returns the grown mask.
 */
export function growMask(mask: Mask, radius: number): Mask {
  const r = Math.max(0, Math.round(radius))
  if (r === 0) return mask
  const { width, height } = mask
  const across = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let best = 0
      for (let dx = Math.max(0, x - r); dx <= Math.min(width - 1, x + r) && best < 255; dx++) best = Math.max(best, mask.data[row + dx] ?? 0)
      across[row + x] = best
    }
  }
  const data = new Uint8Array(width * height)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let best = 0
      for (let dy = Math.max(0, y - r); dy <= Math.min(height - 1, y + r) && best < 255; dy++) best = Math.max(best, across[dy * width + x] ?? 0)
      data[y * width + x] = best
    }
  }
  return { width, height, data }
}

/**
 * A zone checked: four numbers in 0…1 that stay inside the photo, at least 2%
 * of each side — the same rule the studio applies to a region.
 * @param zone - what the caller sent.
 * @returns the zone.
 */
export function checkedZone(zone: Fractions): Fractions {
  const { x, y, w, h } = zone
  if (![x, y, w, h].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error('region: x, y, w, h are fractions between 0 and 1')
  if (w < 0.02 || h < 0.02) throw new Error('region: w and h must be at least 0.02')
  if (x + w > 1.0001 || y + h > 1.0001) throw new Error('region: it goes past the edge of the photo (x + w and y + h must stay ≤ 1)')
  return zone
}

/**
 * A white rectangle on black, at the photo's size.
 * @param width - the photo's width in pixels.
 * @param height - the photo's height in pixels.
 * @param zone - the rectangle, in fractions.
 * @returns the mask.
 */
export function rectangleMask(width: number, height: number, zone: Fractions): Mask {
  const { x, y, w, h } = checkedZone(zone)
  const data = new Uint8Array(width * height)
  const left = Math.round(x * width)
  const top = Math.round(y * height)
  const right = Math.min(width, Math.round((x + w) * width))
  const bottom = Math.min(height, Math.round((y + h) * height))
  for (let row = top; row < bottom; row++) data.fill(255, row * width + left, row * width + right)
  return { width, height, data }
}

/**
 * A mask as the data URL the studio's routes take.
 * @param mask - the mask.
 * @returns `data:image/png;base64,…`.
 */
export function maskDataUrl(mask: Mask): string {
  return `data:image/png;base64,${writeMask(mask).toString('base64')}`
}
