/**
 * The measurements of a template's compositions, without ffmpeg: the
 * photo-booth strip inside the 2048-pixel ceiling, the lines of a poster in
 * their places, and the output name reserved before anything is written.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reserveOutputPath, stripLayout, textBlocks } from '../server/vendor/tool-comfy/template-compose.ts'

/** The ceiling every composition stays inside, and the strip's own margins. */
const TOTAL_SIDE = 2048
const STRIP_MARGIN = 40
const GAP = 24

/** The height of a measured strip, margins and gaps included. */
function stripHeight(strip: ReturnType<typeof stripLayout>): number {
  return strip.heights.reduce((total, height) => total + height, 0) + GAP * (strip.heights.length - 1) + 2 * STRIP_MARGIN
}

test('a photo-booth strip of sixteen tall photos stays inside the ceiling', () => {
  // Sixteen 3:4 portraits used to be drawn at the 256-pixel floor: over
  // 5000 pixels tall.
  const strip = stripLayout(Array.from({ length: 16 }, () => ({ width: 3000, height: 4000 })))
  assert.ok(stripHeight(strip) <= TOTAL_SIDE, `the strip is ${String(stripHeight(strip))} px tall`)
  assert.equal(strip.heights.length, 16, 'every photo still fits, narrower')
  assert.ok(strip.width + 2 * STRIP_MARGIN <= TOTAL_SIDE)
})

test('a strip too long even at its narrowest keeps the photos that fit', () => {
  const strip = stripLayout(Array.from({ length: 16 }, () => ({ width: 1000, height: 3000 })))
  assert.ok(stripHeight(strip) <= TOTAL_SIDE, `the strip is ${String(stripHeight(strip))} px tall`)
  assert.ok(strip.heights.length < 16 && strip.heights.length >= 1, `kept ${String(strip.heights.length)} photos`)
  assert.ok(strip.width >= 64, 'and does not shrink past its floor')
})

test('a short strip is as wide as it may be, and never wider', () => {
  const strip = stripLayout([{ width: 1600, height: 900 }, { width: 1600, height: 900 }])
  assert.equal(strip.width, 1024)
  assert.ok(stripHeight(strip) <= TOTAL_SIDE)
})

test('an empty first line keeps the second at the second size, not the headline\'s', () => {
  const full = textBlocks(['one', 'two', 'three'], 1080, 1080)
  const holed = textBlocks(['', 'two', ''], 1080, 1080)
  assert.equal(holed.length, 1, 'only the line with words is drawn')
  const [second] = holed
  assert.ok(second)
  assert.equal(second.position, 1, 'it is still the second line')
  assert.equal(second.size, full[1]?.size, 'at the second line\'s size')
  assert.notEqual(second.size, full[0]?.size, 'not at the headline\'s')
  assert.deepEqual(textBlocks(['', '', ''], 1080, 1080), [], 'no words, no band')
})

test('two compositions of the same values reserve two names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagine-reserve-'))
  try {
    const declared = join(dir, 'template_grid-abc.png')
    // At the same time: the check-then-write this replaced gave both the same name.
    const names = await Promise.all([reserveOutputPath(declared), reserveOutputPath(declared), reserveOutputPath(declared)])
    assert.equal(new Set(names).size, 3, `the same name twice: ${names.join(', ')}`)
    assert.ok(names.includes(declared), 'the declared name is the first one taken')
    assert.deepEqual((await readdir(dir)).sort(), ['template_grid-abc-2.png', 'template_grid-abc-3.png', 'template_grid-abc.png'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
