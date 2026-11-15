/**
 * The seed goes on the field the graph's node really has.
 *
 * `writeWorkflowSeed` wrote only the pinned name (`seedField`), and there is
 * one pin per configuration entry: an entry can have two graphs (`path` and
 * `pathHigh`, as the character swap had) and the second may use a `RandomNoise`, which calls the seed
 * `noise_seed`. Result: the "Quality" graph got no seed and renders were not
 * reproducible (measured on 2026-11-06).
 *
 * This covers the four cases that matter: the pinned name is present; the
 * pinned name is missing and is replaced by the other known one; the node has
 * neither (it must not throw, and must not invent a field); and the explicit
 * pin wins when the node has both.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeWorkflowSeed, type LoadedWorkflow } from '../server/vendor/tool-comfy/index.ts'

/** A node that stores its seed under `field`. */
function sampler(field: string, value = -1): { class_type: string; inputs: Record<string, unknown> } {
  return { class_type: field === 'noise_seed' ? 'RandomNoise' : 'KSampler', inputs: { [field]: value } }
}

/** A graph holding one node. */
function graphOf(node: ReturnType<typeof sampler>): Record<string, ReturnType<typeof sampler>> {
  return { '42': node }
}

/** The pins a deployment may declare for the seed. */
function workflowOf(seedField: string | undefined): LoadedWorkflow {
  return {
    seedNodeId: '42',
    ...seedField === undefined ? {} : { seedField },
  } as unknown as LoadedWorkflow
}

test('a node with `seed` gets the seed, with and without a pin', () => {
  for (const field of [undefined, 'seed']) {
    const graph = graphOf(sampler('seed'))
    writeWorkflowSeed(graph, workflowOf(field), 1234)
    assert.equal(graph['42']?.inputs.seed, 1234, `seedField=${String(field)}`)
  }
})

test('without a pin, a node with only `noise_seed` gets the seed there', () => {
  const graph = graphOf(sampler('noise_seed'))
  writeWorkflowSeed(graph, workflowOf(undefined), 777)
  assert.equal(graph['42']?.inputs.noise_seed, 777)
})

test('the defect case: pin `seed`, node with `noise_seed`', () => {
  // This was the "Quality" graph of the character swap (RandomNoise): it used
  // to get no seed and the render was not reproducible.
  const graph = graphOf(sampler('noise_seed'))
  writeWorkflowSeed(graph, workflowOf('seed'), 424242)
  assert.equal(graph['42']?.inputs.noise_seed, 424242)
  assert.equal('seed' in (graph['42']?.inputs ?? {}), false, 'must not invent a `seed` field')
})

test('and the symmetric case: pin `noise_seed`, node with `seed`', () => {
  const graph = graphOf(sampler('seed'))
  writeWorkflowSeed(graph, workflowOf('noise_seed'), 99)
  assert.equal(graph['42']?.inputs.seed, 99)
})

test('a node with neither name is left as is, without throwing', () => {
  const node = { class_type: 'KSampler', inputs: { steps: 8 } }
  const graph = { '42': node }
  assert.doesNotThrow(() => { writeWorkflowSeed(graph, workflowOf('seed'), 5) })
  assert.deepEqual(node.inputs, { steps: 8 })
})

test('the explicit pin wins when the node has both names', () => {
  const graph = { '42': { class_type: 'RandomNoise', inputs: { seed: 0, noise_seed: 0 } } }
  writeWorkflowSeed(graph, workflowOf('noise_seed'), 31)
  assert.equal(graph['42']?.inputs.noise_seed, 31)
  assert.equal(graph['42']?.inputs.seed, 0)
})

test('the pin is honoured even with a third name: only that one is written', () => {
  const graph = { '42': { class_type: 'KSampler', inputs: { seed: 0, noise_seed: 0 } } }
  writeWorkflowSeed(graph, workflowOf('random_seed'), 12)
  assert.deepEqual(graph['42']?.inputs, { seed: 0, noise_seed: 0 })
})

test('without a seed one is made up, in the node\'s right field', () => {
  const graph = graphOf(sampler('noise_seed'))
  writeWorkflowSeed(graph, workflowOf('seed'), undefined)
  const value = graph['42']?.inputs.noise_seed
  assert.equal(typeof value, 'number')
  assert.ok(Number.isInteger(value) && (value as number) >= 0)
})
