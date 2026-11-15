/**
 * The batch control of an uploaded card: `batchControl` must be in the meta,
 * point at a node and a field that exist, and have at least two real values.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'imagine-custom-batch-'))
const dataDir = join(root, 'data')
await mkdir(join(dataDir, 'custom-workflows'), { recursive: true })
// The data root is read when the module loads, so it is set first: a variable
// in the environment can never send the test to real data.
process.env.IMAGINE_HOME = dataDir
const { listCustomWorkflows, saveCustomWorkflow } = await import('../server/vendor/tool-comfy/custom-workflows.ts')

after(async () => { await rm(root, { recursive: true, force: true }) })

const GRAPH = {
  '276': { class_type: 'PromptSelector', inputs: { title: 'CARABINIERA', pose: '(nessuna posa)' } },
}

const POSES = ['(nessuna posa)', 'A - SDRAIATA', 'B - IN PIEDI']

test('a valid batch is saved and read back', async () => {
  const meta = await saveCustomWorkflow({
    title: 'Batch test',
    description: '',
    graph: GRAPH,
    output: 'image',
    outputExt: 'webp',
    batchControl: { node: '276', field: 'pose' },
  }, { batchValues: () => POSES })
  assert.deepEqual(meta.batchControl, { node: '276', field: 'pose' })
  const stored = (await listCustomWorkflows()).find(entry => entry.id === meta.id)
  assert.deepEqual(stored?.batchControl, { node: '276', field: 'pose' })
})

test('a batch naming a missing node is refused', async () => {
  await assert.rejects(saveCustomWorkflow({
    title: 'Batch wrong node',
    description: '',
    graph: GRAPH,
    output: 'image',
    outputExt: 'webp',
    batchControl: { node: '999', field: 'pose' },
  }, { batchValues: () => POSES }), /nodo 999/)
})

test('a batch naming a missing field is refused', async () => {
  await assert.rejects(saveCustomWorkflow({
    title: 'Batch wrong field',
    description: '',
    graph: GRAPH,
    output: 'image',
    outputExt: 'webp',
    batchControl: { node: '276', field: 'nonesiste' },
  }, { batchValues: () => POSES }), /campo nonesiste/)
})

test('a field with a single real value is not a batch', async () => {
  await assert.rejects(saveCustomWorkflow({
    title: 'Batch of one',
    description: '',
    graph: GRAPH,
    output: 'image',
    outputExt: 'webp',
    batchControl: { node: '276', field: 'pose' },
  }, { batchValues: () => ['(nessuna posa)', 'A - SDRAIATA'] }), /almeno due/)
})

test('without the values reader the batch is not saved', async () => {
  await assert.rejects(saveCustomWorkflow({
    title: 'Batch without values',
    description: '',
    graph: GRAPH,
    output: 'image',
    outputExt: 'webp',
    batchControl: { node: '276', field: 'pose' },
  }), /valori del campo/)
})
