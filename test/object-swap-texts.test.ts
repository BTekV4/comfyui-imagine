/**
 * The object swap's texts for Openjutsu's plan: a short `target` and a short
 * `change_to`, read off the vision replies, never the old H3 documents.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { objectSwapTextsOf } from '../server/vendor/tool-comfy/object-swap-texts.ts'

test('change: the photo names what the object becomes', () => {
  const texts = objectSwapTextsOf('change', 'target: mug, cup\nchange_to: the object in the photo', 'change_to: a blue glass bottle with a cork.')
  assert.deepEqual(texts, { track: 'mug, cup', reference: 'a blue glass bottle with a cork', scene: 'Replace the mug, cup with a blue glass bottle with a cork.' })
})

test('change: an unreadable photo leaves the placeholder out, not in change_to', () => {
  const texts = objectSwapTextsOf('change', 'target: mug\nchange_to: the object in the photo', '')
  assert.equal(texts?.reference, '')
})

test('remove: change_to is what shows instead, on one line', () => {
  const texts = objectSwapTextsOf('remove', '**target:** bottle, person\n**change_to:** the bare wooden\ntable top.')
  assert.equal(texts?.track, 'bottle')
  assert.equal(texts?.reference, 'the bare wooden table top')
  assert.ok(!(texts?.reference ?? '').includes('subject_definitions'))
})

test('background keeps the person as the target', () => {
  const texts = objectSwapTextsOf('background', 'target: woman\nchange_to: a sunny beach with palm trees')
  assert.equal(texts?.track, 'woman')
  assert.equal(texts?.reference, 'a sunny beach with palm trees')
})

test('a reply without a target leaves the graph its own texts', () => {
  assert.equal(objectSwapTextsOf('add', 'change_to: a lamp'), undefined)
})
