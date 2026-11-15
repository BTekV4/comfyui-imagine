/**
 * «Colori» and «Disegna»: the sentences sent, the colour names, the colours
 * read off a picture. The palette sentence is Grok's own (read 2026-11-15).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { colorName, drawPrompt, mainColors, palettePrompt, PALETTE_PRESETS, rgbOf } from '../shared/imagine-post-tools.ts'

test('a palette of four is listed with names, in Grok\'s sentence', () => {
  const prompt = palettePrompt(['#9C4A2F', '#D9B382', '#4F5D45', '#F3EDE3'])
  assert.ok(prompt.startsWith('Restyle this design so that every colour in it comes from this 4-colour palette: #9C4A2F (terracotta), '))
  assert.ok(prompt.endsWith('do not add any swatches, labels or extra text.'))
})

test('one colour is a monochrome, two a duotone', () => {
  assert.match(palettePrompt(['#3B82F6']), /1-colour palette: #3B82F6 \(blue\), rendered as a monochrome treatment/)
  assert.match(palettePrompt(['#000000', '#ffffff']), /2-colour palette: #000000 \(black\), #FFFFFF \(white\), rendered as a duotone/)
})

test('the ten presets are Grok\'s, four colours each', () => {
  assert.equal(PALETTE_PRESETS.length, 10)
  for (const preset of PALETTE_PRESETS) assert.equal(preset.colors.filter(color => rgbOf(color) !== undefined).length, 4, preset.id)
})

test('colour names are the nearest plain ones', () => {
  assert.equal(colorName('#FF0000'), 'red')
  assert.equal(colorName('#0D47A1'), 'navy')
  assert.equal(colorName('nope'), 'colour')
})

test('the main colours of a picture come out darkest first', () => {
  const pixels: number[] = []
  for (let i = 0; i < 50; i += 1) pixels.push(250, 250, 250, 255)
  for (let i = 0; i < 50; i += 1) pixels.push(10, 10, 200, 255)
  for (let i = 0; i < 10; i += 1) pixels.push(0, 0, 0, 0)
  assert.deepEqual(mainColors(pixels, 2), ['#0A0AC8', '#FAFAFA'])
  assert.deepEqual(mainColors([], 4), [])
})

test('a sketch is finished in its style, with the words when there are some', () => {
  const plain = drawPrompt('manga', '  ')
  assert.match(plain, /^The image has a rough hand-drawn sketch/)
  assert.match(plain, /manga line art/)
  assert.doesNotMatch(plain, /showing/)
  assert.match(drawPrompt('photo', 'a red balloon!'), /showing a red balloon, rendered in the same style/)
})
