/**
 * The grounding helpers the written lane runs on: the question asked of the
 * photo, the box read back, the grown box the eraser paints, and the two
 * sentences that decide a host edit from the user's own words.
 *
 * No model and no browser: the parse is fed the shapes a vision model really
 * answers with, the growth is checked against the frame's edges.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GROUNDING_GROW, groundingInstruction, grownRegion, parseGrounding, wantsAudioMerge, wantsTextRemoval,
} from '../shared/imagine-grounding.ts'

test('the grounding question carries the user’s word and the picture’s description', () => {
  const instruction = groundingInstruction({ target: 'la borsa', description: 'A woman holding a red handbag.' })
  assert.ok(instruction.includes('"la borsa"'), 'the user’s word is not quoted')
  assert.ok(instruction.includes('A woman holding a red handbag.'), 'the description never reached the question')
  // The rephrase step is spelled out: the model has to match the word to the
  // picture before it draws a box.
  assert.match(instruction, /translate their word into what is really in the picture/)
  assert.ok(instruction.includes('{"found": true, "box": [x1, y1, x2, y2]}'), 'the answer shape is not given')
})

test('the grounding question says so when there is no description yet', () => {
  const instruction = groundingInstruction({ target: 'the watermark' })
  assert.match(instruction, /has not been described yet/)
  assert.match(instruction, /work out what the user means from the picture itself/)
})

test('a box in thousandths becomes fractions of the photo', () => {
  assert.deepEqual(parseGrounding('{"found": true, "box": [100, 200, 500, 700]}'), {
    x: 0.1, y: 0.2, w: 0.4, h: 0.5,
  })
})

test('the answer is read through a fence and a sentence around it', () => {
  assert.deepEqual(parseGrounding('Here it is:\n```json\n{"found": true, "box": [0, 0, 1000, 1000]}\n```'), {
    x: 0, y: 0, w: 1, h: 1,
  })
})

test('a box in fractions is accepted as the model may write it too', () => {
  assert.deepEqual(parseGrounding('{"box": {"x": 0.25, "y": 0.5, "w": 0.25, "h": 0.25}}'), {
    x: 0.25, y: 0.5, w: 0.25, h: 0.25,
  })
})

test('nothing found, and a reply that is not JSON, both answer nothing', () => {
  assert.equal(parseGrounding('{"found": false}'), undefined)
  assert.equal(parseGrounding('I cannot see that in the picture.'), undefined)
  assert.equal(parseGrounding(undefined), undefined)
  // A box of no area is not a box.
  assert.equal(parseGrounding('{"box": [400, 400, 400, 400]}'), undefined)
})

test('the box is grown on every side and kept inside the photo', () => {
  const grown = grownRegion({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 })
  assert.ok(grown.x < 0.4 && grown.y < 0.4, 'the box was not grown on the top-left')
  assert.ok(grown.x + grown.w > 0.6 && grown.y + grown.h > 0.6, 'the box was not grown on the bottom-right')
  // The growth is a share of the box's own side.
  assert.ok(Math.abs(grown.x - (0.4 - 0.2 * GROUNDING_GROW)) < 1e-9)
  const edge = grownRegion({ x: 0, y: 0, w: 0.1, h: 0.1 })
  assert.equal(edge.x, 0, 'the box left the photo on the left')
  assert.equal(edge.y, 0, 'the box left the photo on the top')
  const corner = grownRegion({ x: 0.95, y: 0.95, w: 0.05, h: 0.05 })
  assert.ok(corner.x + corner.w <= 1 && corner.y + corner.h <= 1, 'the box left the photo on the bottom-right')
})

test('writing, a logo or a watermark to take out is the eraser’s case', () => {
  for (const line of [
    'togli la scritta in basso',
    'rimuovi il logo dal muro',
    'cancella il watermark',
    'remove the watermark from the photo',
    'erase the text at the bottom',
    'leva la filigrana',
  ]) {
    assert.equal(wantsTextRemoval(line), true, line)
  }
})

test('changing the writing, or removing something else, is not the eraser', () => {
  for (const line of [
    'cambia la scritta in “Aperto”',
    'togli la persona dallo sfondo',
    'remove the extra arm',
    'aggiungi un logo',
    'genera un testo per il post',
  ]) {
    assert.equal(wantsTextRemoval(line), false, line)
  }
})

test('laying a track over a clip is recognised, a song to generate is not', () => {
  assert.equal(wantsAudioMerge('unisci questa canzone a questo video'), true)
  assert.equal(wantsAudioMerge('metti la traccia audio sul video'), true)
  assert.equal(wantsAudioMerge('add this audio to the clip'), true)
  assert.equal(wantsAudioMerge('fammi una canzone'), false)
  assert.equal(wantsAudioMerge('cambia la voce di questa clip'), false)
})
