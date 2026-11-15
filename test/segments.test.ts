/**
 * «Segmenti»: reading the index the ComfyUI node writes, and the file names
 * the server agrees to serve from a photo's folder.
 *
 * The index below is the node's own output on 2026-11-14 (one object, one
 * text), plus the slips a hand-edited or truncated file could carry.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSegmentFile, parseNodeIndex } from '../server/vendor/tool-comfy/segments.ts'
import { groupSegments, segmentFileUrl, segmentZipNames, textEditPrompt } from '../shared/imagine-segments.ts'

const NODE_INDEX = JSON.stringify({
  width: 1080,
  height: 1080,
  segments: [
    { index: 0, kind: 'object', label: 'woman', score: 0.99, bbox: { x: 276, y: 67, w: 534, h: 1013 }, area: 0.319, mask: 'seg_00001_mask_000.png', cut: 'seg_00001_cut_000.png' },
    { index: 1, kind: 'text', label: 'VER', score: 0.63, bbox: { x: 127, y: 594, w: 92, h: 42 }, area: 0.003, mask: 'seg_00001_mask_001.png', cut: 'seg_00001_cut_001.png' },
    { index: 2, kind: 'object', label: 'bad', bbox: { x: 0, y: 0, w: 1, h: 1 }, mask: '../../etc/passwd', cut: 'seg_00001_cut_002.png' },
    { index: 3, label: 'no box', mask: 'seg_00001_mask_003.png', cut: 'seg_00001_cut_003.png' },
  ],
})

test('the node index is read, kinds kept, unsafe or broken entries dropped', () => {
  const index = parseNodeIndex(NODE_INDEX, 'generate_image-16d52adf.webp', 'omniroute/strata/qwen3.8-flash-next')
  assert.ok(index)
  assert.equal(index.photo, 'generate_image-16d52adf.webp')
  assert.equal(index.width, 1080)
  assert.equal(index.model, 'omniroute/strata/qwen3.8-flash-next')
  assert.deepEqual(index.segments.map(segment => [segment.label, segment.kind]), [['woman', 'object'], ['VER', 'text']])
  assert.deepEqual(index.segments[0]!.bbox, { x: 276, y: 67, w: 534, h: 1013 })
  assert.ok(!Number.isNaN(Date.parse(index.createdAt)))
})

test('what is not an index is no index', () => {
  assert.equal(parseNodeIndex('not json', 'a.webp'), undefined)
  assert.equal(parseNodeIndex('{"segments": []}', 'a.webp'), undefined)
  assert.equal(parseNodeIndex('[]', 'a.webp'), undefined)
  assert.deepEqual(parseNodeIndex('{"width": 2, "height": 2, "segments": []}', 'a.webp')?.segments, [])
})

test('only the node\'s mask and cut-out names are files', () => {
  assert.ok(isSegmentFile('generate_image-16d52adf_00003_mask_012.png'))
  assert.ok(isSegmentFile('seg_00001_cut_000.png'))
  assert.equal(isSegmentFile('index.json'), false)
  assert.equal(isSegmentFile('../seg_00001_cut_000.png'), false)
  assert.equal(isSegmentFile('seg_00001_cut_000.png.exe'), false)
})

test('a file URL carries the analysis time', () => {
  const index = parseNodeIndex(NODE_INDEX, 'a b.webp')!
  const url = segmentFileUrl(index, 'seg_00001_cut_000.png')
  assert.ok(url.startsWith('/api/segments/file/a%20b.webp/seg_00001_cut_000.png?v='))
})

const at = (index: number, label: string, x: number, y: number, w: number, h: number, kind: "object" | "text" = "object") => ({
  index, kind, label, score: 1, bbox: { x, y, w, h }, area: 0, mask: "m.png", cut: "c.png",
})

test("parts with one name are one group, in the order the first came; a text is never grouped with an object", () => {
  const groups = groupSegments([
    at(0, "ring", 0, 0, 1, 1), at(1, "cup", 0, 0, 1, 1), at(2, "Ring", 0, 0, 1, 1), at(3, "cup", 0, 0, 1, 1, "text"),
  ])
  assert.deepEqual(groups.map(group => [group.label, group.kind, group.members.map(member => member.index)]), [
    ["ring", "object", [0, 2]], ["cup", "object", [1]], ["cup", "text", [3]],
  ])
})

test("the zip names follow Grok: one part is <label>.png, a group gets a folder", () => {
  assert.deepEqual(segmentZipNames(["woman", "Black Flip-Flops", "black flip-flops", "Black Flip-Flops", "☕", "☕"]), [
    "woman.png", "black-flip-flops/black-flip-flops-1.png", "black-flip-flops.png", "black-flip-flops/black-flip-flops-2.png",
    "object/object-1.png", "object/object-2.png",
  ])
})

test("a text edit becomes one sentence, the user's words last", () => {
  assert.equal(textEditPrompt("87", { text: "87", size: 0 }, ""), "")
  assert.equal(textEditPrompt("87", { text: "88", size: 0 }, ""), 'Replace the text "87" with "88", keeping its position, perspective and lighting.')
  assert.equal(
    textEditPrompt("OPEN", { text: "OPEN", color: "#ff0000", font: "marker", size: -1, align: "center" }, "make it glow"),
    'Restyle the text "OPEN": colour #ff0000, a hand-drawn marker typeface, 15% smaller, center aligned. make it glow',
  )
})
