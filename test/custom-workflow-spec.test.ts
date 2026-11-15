/**
 * Deriving an uploaded card's controls from its graph: file slots, options
 * and dropdowns. Simple rules, no invented controls.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveCustomWorkflowControls, type CustomGraph } from '../web/vendor-imagine/client/custom-workflow-spec.ts'

const GRAPH: CustomGraph = {
  '10': { class_type: 'LoadImage', inputs: { image: 'x.png', upload: 'image' } },
  '11': { class_type: 'LoadImageMask', inputs: { image: 'mask.png', channel: 'red' } },
  '12': { class_type: 'LoadVideoUpload', inputs: { file: 'clip.mp4' } },
  '13': { class_type: 'LoadAudio', inputs: { audio: 'song.mp3' } },
  '20': { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '9:16 (Portrait Widescreen)', megapixels: 2 } },
  '30': { class_type: 'PromptSelector', inputs: { title: 'CARABINIERA', pose: '(nessuna posa)' } },
  '40': { class_type: 'SomeLatent', inputs: { seconds: 5 } },
  '50': { class_type: 'KSampler', inputs: { seed: 1, steps: 10 } },
}

test('load nodes become slots, keyed by node id', () => {
  const controls = deriveCustomWorkflowControls({}, GRAPH)
  assert.deepEqual(controls.slots.map(slot => ({ key: slot.key, node: slot.node, field: slot.field, kind: slot.kind, required: slot.required })), [
    { key: '10', node: '10', field: 'image', kind: 'image', required: true },
    { key: '11', node: '11', field: 'image', kind: 'image', required: false },
    { key: '12', node: '12', field: 'file', kind: 'video', required: true },
    { key: '13', node: '13', field: 'audio', kind: 'audio', required: true },
  ])
})

test('ResolutionSelector gives aspect and resolution, the duration node gives seconds', () => {
  const controls = deriveCustomWorkflowControls({}, GRAPH)
  assert.deepEqual([...controls.options], ['aspect', 'resolution', 'seconds'])
  assert.deepEqual(controls.aspect, { node: '20', field: 'aspect_ratio', labels: controls.aspect?.labels })
  assert.equal(controls.aspect?.labels['9:16'], '9:16 (Portrait Widescreen)')
  assert.deepEqual(controls.resolution, { node: '20', field: 'megapixels' })
  assert.deepEqual(controls.seconds, { node: '40', field: 'seconds' })
})

test('a PromptSelector gives the title and pose dropdowns', () => {
  const controls = deriveCustomWorkflowControls({}, GRAPH)
  assert.deepEqual(controls.combos.map(combo => [combo.key, combo.node, combo.field]), [
    ['30.title', '30', 'title'],
    ['30.pose', '30', 'pose'],
  ])
})

test('the prompt comes from the meta pins, and is optional when a dropdown covers it', () => {
  const lookbook = deriveCustomWorkflowControls({ promptNodeId: '30', promptField: 'title', seedNodeId: '50', seedField: 'seed' }, GRAPH)
  assert.deepEqual(lookbook.prompt, { node: '30', field: 'title', required: false })
  assert.deepEqual(lookbook.seed, { node: '50', field: 'seed' })
  const generate = deriveCustomWorkflowControls({ promptNodeId: '50' }, GRAPH)
  assert.deepEqual(generate.prompt, { node: '50', required: true })
  assert.equal(generate.seed, undefined)
})

test('the batch declared by the meta reaches the controls, and is absent without it', () => {
  const withBatch = deriveCustomWorkflowControls(
    { promptNodeId: '30', promptField: 'title', batchControl: { node: '30', field: 'pose' } },
    GRAPH,
  )
  assert.deepEqual(withBatch.batch, { node: '30', field: 'pose' })
  const withoutBatch = deriveCustomWorkflowControls({ promptNodeId: '30', promptField: 'title' }, GRAPH)
  assert.equal(withoutBatch.batch, undefined)
})

test('a graph with no loads, selectors or duration invents nothing', () => {
  const controls = deriveCustomWorkflowControls({ promptNodeId: '50' }, {
    '50': { class_type: 'PrimitiveStringMultiline', inputs: { value: '' } },
    '51': { class_type: 'SomeUnknownNode', inputs: { text: 'x' } },
  })
  assert.deepEqual(controls.slots, [])
  assert.deepEqual([...controls.options], [])
  assert.deepEqual(controls.combos, [])
  assert.equal(controls.aspect, undefined)
  assert.equal(controls.seconds, undefined)
})

test('duration is recognised only when the field is a number', () => {
  const controls = deriveCustomWorkflowControls({}, {
    '1': { class_type: 'X', inputs: { seconds: 'cinque' } },
  })
  assert.equal(controls.seconds, undefined)
})
