/**
 * «Segmenti»: reading the vision model's list of things and texts.
 *
 * The replies below are the shapes the models gave on 2026-11-14: a fenced
 * block (qwen3.8-flash-next), bare JSON (glm-5.3-flash), and the slips worth
 * guarding against — commas inside a name (the node would split it into two
 * concepts), a count of 0, a box written backwards.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CONCEPTS, MAX_COUNT, conceptLines, conceptName, parseSegmentSight,
} from '../server/vendor/tool-comfy/segment-concepts.ts'

test('a fenced reply is read, names lowercased and texts turned into fractions', () => {
  const reply = 'Here it is:\n```json\n{"objects": [{"name": "Woman with rainbow hair", "count": 1}, {"name": "neon sign", "count": 5}],'
    + ' "texts": [{"text": "CARO", "box": [642, 408, 715, 438]}]}\n```'
  const sight = parseSegmentSight(reply)
  assert.ok(sight)
  assert.deepEqual(sight.concepts, [{ name: 'woman with rainbow hair', count: 1 }, { name: 'neon sign', count: 5 }])
  assert.equal(sight.texts.length, 1)
  assert.equal(sight.texts[0].text, 'CARO')
  const box = sight.texts[0].box
  assert.ok(Math.abs(box.x - 0.642) < 1e-9 && Math.abs(box.y - 0.408) < 1e-9)
  assert.ok(Math.abs(box.w - 0.073) < 1e-9 && Math.abs(box.h - 0.03) < 1e-9)
})

test('names lose what would break the node list, duplicates go', () => {
  assert.equal(conceptName('ring, gold (left hand)'), 'ring gold left hand')
  assert.equal(conceptName('label: "OPEN"'), 'label open')
  assert.equal(conceptName('   '), undefined)
  assert.equal(conceptName('x'.repeat(61)), undefined)
  const sight = parseSegmentSight('{"objects": [{"name": "Ring", "count": 3}, {"name": "ring", "count": 1}, {"name": "cup"}]}')
  assert.deepEqual(sight?.concepts, [{ name: 'ring', count: 3 }, { name: 'cup', count: 1 }])
})

test('counts are whole, at least one, at most the ceiling', () => {
  const sight = parseSegmentSight('{"objects": [{"name": "a", "count": 0}, {"name": "b", "count": 2.6}, {"name": "c", "count": 500}, {"name": "d", "count": "x"}]}')
  assert.deepEqual(sight?.concepts.map(concept => concept.count), [1, 3, MAX_COUNT, 1])
})

test('a backwards box is put right, a broken or empty one drops the text', () => {
  const sight = parseSegmentSight('{"texts": [{"text": "A", "box": [500, 600, 400, 500]}, {"text": "B", "box": [1, 2, 3]},'
    + ' {"text": "C", "box": [10, 10, 10, 10]}, {"text": "", "box": [0, 0, 100, 100]}, {"text": "D", "box": [-50, 0, 2000, 100]}]}')
  assert.ok(sight)
  assert.deepEqual(sight.texts.map(text => text.text), ['A', 'D'])
  assert.deepEqual(sight.texts[0].box, { x: 0.4, y: 0.5, w: 0.1, h: 0.1 })
  assert.deepEqual(sight.texts[1].box, { x: 0, y: 0, w: 1, h: 0.1 })
})

test('no list at all is no sight; the list is capped', () => {
  assert.equal(parseSegmentSight(undefined), undefined)
  assert.equal(parseSegmentSight('I cannot see the image.'), undefined)
  assert.equal(parseSegmentSight('{"objects": [], "texts": []}'), undefined)
  const many = JSON.stringify({ objects: Array.from({ length: 60 }, (_, i) => ({ name: `thing ${String(i)}`, count: 1 })) })
  assert.equal(parseSegmentSight(many)?.concepts.length, MAX_CONCEPTS)
})

test('the node gets one name:N per line, two more than counted', () => {
  assert.equal(conceptLines([{ name: 'coffee cup', count: 2 }, { name: 'ring', count: MAX_COUNT }]), `coffee cup:4\nring:${String(MAX_COUNT)}`)
})
