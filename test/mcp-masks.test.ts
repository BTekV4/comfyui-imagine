/**
 * The masks the MCP tools build for Precise edit and Remove object: a
 * segment's PNG read back, several joined (the lighter pixel wins, as the
 * page's canvas does), a rectangle drawn at the photo's size, and the zone
 * rules the studio applies.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { checkedZone, growMask, joinMasks, maskDataUrl, readMask, rectangleMask, writeMask } from '../shared/masks.ts'

const dir = await mkdtemp(join(tmpdir(), 'imagine-mcp-masks-'))
after(async () => { await rm(dir, { recursive: true, force: true }) })

/** A real PNG from ffmpeg (it uses every row filter): a white box on black. */
async function ffmpegMask(name: string, box: string, format: 'gray' | 'rgb24' | 'rgba'): Promise<Uint8Array> {
  const file = join(dir, name)
  await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:size=64x48',
    '-vf', `drawbox=${box}:color=white:t=fill,format=${format}`, '-frames:v', '1', '-y', file])
  return new Uint8Array(await readFile(file))
}

const at = (mask: { width: number; data: Uint8Array }, x: number, y: number): number => mask.data[y * mask.width + x] ?? -1

test('a PNG written here reads back the same', () => {
  const mask = rectangleMask(40, 30, { x: 0.25, y: 0.5, w: 0.5, h: 0.25 })
  const back = readMask(writeMask(mask))
  assert.equal(back.width, 40)
  assert.equal(back.height, 30)
  assert.deepEqual(back.data, mask.data)
  assert.equal(at(back, 10, 15), 255)
  assert.equal(at(back, 9, 15), 0)
  assert.equal(at(back, 29, 22), 255)
  assert.equal(at(back, 30, 22), 0)
})

test('greyscale, RGB and RGBA PNGs from ffmpeg are read, filters included', async () => {
  for (const format of ['gray', 'rgb24', 'rgba'] as const) {
    const mask = readMask(await ffmpegMask(`box-${format}.png`, 'x=10:y=8:w=20:h=12', format))
    assert.equal(mask.width, 64, format)
    assert.equal(mask.height, 48, format)
    assert.ok(at(mask, 15, 12) > 200, `${format}: inside the box is white`)
    assert.ok(at(mask, 5, 5) < 50, `${format}: outside is black`)
    assert.ok(at(mask, 40, 30) < 50, `${format}: outside is black`)
  }
})

test('joined masks keep every segment: the lighter pixel wins', async () => {
  const left = readMask(await ffmpegMask('left.png', 'x=0:y=0:w=10:h=48', 'gray'))
  const right = readMask(await ffmpegMask('right.png', 'x=54:y=0:w=10:h=48', 'gray'))
  const both = joinMasks([left, right])
  assert.ok(at(both, 2, 20) > 200)
  assert.ok(at(both, 60, 20) > 200)
  assert.ok(at(both, 32, 20) < 50)
  assert.throws(() => joinMasks([left, rectangleMask(10, 10, { x: 0, y: 0, w: 1, h: 1 })]), /different sizes/)
  assert.throws(() => joinMasks([]), /no mask/)
})

test('the data URL is what the studio routes accept', () => {
  const url = maskDataUrl(rectangleMask(8, 8, { x: 0, y: 0, w: 0.5, h: 0.5 }))
  assert.match(url, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
  assert.deepEqual([...Buffer.from(url.split(',')[1] ?? '', 'base64').subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})

test('a zone outside the photo, too small or not fractions is refused', () => {
  assert.deepEqual(checkedZone({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }), { x: 0.1, y: 0.1, w: 0.5, h: 0.5 })
  assert.throws(() => checkedZone({ x: 0.8, y: 0, w: 0.5, h: 0.5 }), /past the edge/)
  assert.throws(() => checkedZone({ x: 0, y: 0, w: 0.01, h: 0.5 }), /at least 0.02/)
  assert.throws(() => checkedZone({ x: -0.1, y: 0, w: 0.5, h: 0.5 }), /fractions/)
  assert.throws(() => checkedZone({ x: 0, y: 0, w: 2, h: 0.5 }), /fractions/)
})

test('not a PNG, or one this reader does not handle, is refused with a reason', () => {
  assert.throws(() => readMask(new Uint8Array([1, 2, 3])), /not a PNG/)
  const png = writeMask(rectangleMask(4, 4, { x: 0, y: 0, w: 1, h: 1 }))
  const sixteen = Buffer.from(png)
  sixteen[8 + 8 + 8] = 16 // IHDR bit depth
  assert.throws(() => readMask(sixteen), /unsupported PNG/)
})

test('a mask grown for Remove object covers a margin around the object, not the whole photo', () => {
  const dot = rectangleMask(40, 40, { x: 0.5, y: 0.5, w: 0.05, h: 0.05 }) // pixels 20,21 on both axes
  const grown = growMask(dot, 3)
  assert.equal(at(grown, 17, 17), 255)
  assert.equal(at(grown, 24, 24), 255)
  assert.equal(at(grown, 16, 20), 0)
  assert.equal(at(grown, 25, 20), 0)
  assert.equal(growMask(dot, 0), dot)
})

/** The square max filter written the slow, obvious way: the reference growMask must match. */
function grownByHand(mask: { width: number; height: number; data: Uint8Array }, r: number): Uint8Array {
  const out = new Uint8Array(mask.width * mask.height)
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      let best = 0
      for (let yy = Math.max(0, y - r); yy <= Math.min(mask.height - 1, y + r); yy++) {
        for (let xx = Math.max(0, x - r); xx <= Math.min(mask.width - 1, x + r); xx++) best = Math.max(best, mask.data[yy * mask.width + xx] ?? 0)
      }
      out[y * mask.width + x] = best
    }
  }
  return out
}

test('the fast grow gives the same pixels as the brute-force filter, grey levels and edges included', () => {
  // A fixed pseudo-random sequence, so a failure is reproducible.
  let seed = 12345
  const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (const [width, height] of [[1, 1], [1, 9], [13, 1], [17, 11], [32, 7]] as const) {
    const data = new Uint8Array(width * height)
    for (let i = 0; i < data.length; i++) data[i] = next() < 0.1 ? Math.floor(next() * 256) : 0
    const mask = { width, height, data }
    for (const r of [1, 2, 3, 5, 8, 40]) {
      assert.deepEqual(growMask(mask, r).data, grownByHand(mask, r), `${String(width)}x${String(height)} r=${String(r)}`)
    }
  }
})
