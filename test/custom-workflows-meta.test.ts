/**
 * The contract of uploaded workflows: `promptField` and `seedField`.
 *
 * On 2026-11-04 a card would not start because that graph's prompt lived on
 * `title` and the contract could not say so: the runner looked only for
 * `value|text|prompt|caption`, did not find it and refused the job. This
 * checks that the meta carries the two fields, that the runner uses them, and
 * that without them the usual behaviour stays.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'imagine-custom-meta-'))
const dataDir = join(root, 'data')
await mkdir(join(dataDir, 'custom-workflows'), { recursive: true })
// `dataPath` reads the data root when the module loads, so it is set first:
// a variable in the environment can never send the test to real data.
process.env.IMAGINE_HOME = dataDir
const { listCustomWorkflows, loadCustomWorkflows, saveCustomWorkflow } = await import('../server/vendor/tool-comfy/custom-workflows.ts')
const { writeWorkflowPrompt, writeWorkflowSeed } = await import('../server/vendor/tool-comfy/index.ts')

after(async () => { await rm(root, { recursive: true, force: true }) })

const LOOKBOOK = 'c399559d-ddb4-4425-bfe5-58582fbcba4e'

/** A workflow folder as the module writes it: meta + graph. */
async function store(id: string, meta: Record<string, unknown>, graph: Record<string, unknown>): Promise<void> {
  const dir = join(dataDir, 'custom-workflows', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ id, inputs: [], ...meta }))
  await writeFile(join(dir, 'graph.json'), JSON.stringify(graph))
}

test('the meta declares which field gets the prompt and the seed', async () => {
  await store(LOOKBOOK, {
    title: 'Lookbook', description: '', output: 'image', outputExt: 'webp',
    promptNodeId: '276', promptField: 'title', seedNodeId: '305', seedField: 'value', hasCover: false,
  }, {
    '276': { class_type: 'PromptSelector', inputs: { title: '', pose: 'standing' } },
    '305': { class_type: 'PrimitiveInt', inputs: { value: 7 } },
  })
  const meta = (await listCustomWorkflows()).find(entry => entry.id === LOOKBOOK)
  assert.equal(meta?.promptField, 'title')
  assert.equal(meta?.seedField, 'value')
  const loaded = (await loadCustomWorkflows())[`custom:${LOOKBOOK}`]
  assert.equal(loaded?.promptField, 'title')
  assert.equal(loaded?.seedField, 'value')
})

test('the synchronous boot loader carries the two fields too', async () => {
  const { loadCustomWorkflowsSync } = await import('../server/vendor/tool-comfy/custom-workflows.ts')
  const loaded = loadCustomWorkflowsSync()[`custom:${LOOKBOOK}`]
  assert.equal(loaded?.promptField, 'title')
  assert.equal(loaded?.seedField, 'value')
})

test('the prompt ends up in the declared field, even an unusual one', () => {
  const graph = { '276': { class_type: 'PromptSelector', inputs: { title: '', pose: 'standing' } } }
  writeWorkflowPrompt(graph as never, { graph, promptNodeId: '276', promptField: 'title' } as never, 'a title')
  assert.equal(graph['276'].inputs.title, 'a title')
  assert.equal(graph['276'].inputs.pose, 'standing')
})

test('without promptField the value/text/prompt/caption lookup stays', () => {
  const graph = { '73': { class_type: 'PrimitiveStringMultiline', inputs: { value: '' } } }
  writeWorkflowPrompt(graph as never, { graph, promptNodeId: '73' } as never, 'text')
  assert.equal(graph['73'].inputs.value, 'text')
  assert.throws(
    () => writeWorkflowPrompt(
      { '9': { class_type: 'X', inputs: { pose: '' } } } as never,
      { graph: {}, promptNodeId: '9' } as never,
      'x',
    ),
    /carries no value/,
  )
})

test('the seed goes to the declared field, or to `seed`', () => {
  const lookbook = { '305': { class_type: 'PrimitiveInt', inputs: { value: 1 } } }
  writeWorkflowSeed(lookbook as never, { graph: lookbook, seedNodeId: '305', seedField: 'value' } as never, 42)
  assert.equal(lookbook['305'].inputs.value, 42)
  const sampler = { '53': { class_type: 'KSampler', inputs: { seed: 0, steps: 10 } } }
  writeWorkflowSeed(sampler as never, { graph: sampler } as never, 7)
  assert.equal(sampler['53'].inputs.seed, 7)
})

test('an upload with a valid promptField is saved and read back', async () => {
  const meta = await saveCustomWorkflow({
    title: 'Prompt field test',
    description: '',
    graph: { '276': { class_type: 'PromptSelector', inputs: { title: '', pose: 'standing' } } },
    output: 'image',
    outputExt: 'webp',
    promptNodeId: '276',
    promptField: 'title',
  })
  assert.equal(meta.promptField, 'title')
  const stored = (await listCustomWorkflows()).find(entry => entry.id === meta.id)
  assert.equal(stored?.promptField, 'title')
})

test('a promptField the node does not have is refused', async () => {
  await assert.rejects(saveCustomWorkflow({
    title: 'Wrong field',
    description: '',
    graph: { '276': { class_type: 'PromptSelector', inputs: { title: '', pose: 'standing' } } },
    output: 'image',
    outputExt: 'webp',
    promptNodeId: '276',
    promptField: 'nonesiste',
  }), /non esiste nel grafo/)
})

test('a card\'s high-quality recipe reaches the runner', async () => {
  const ID = '11111111-2222-4333-8444-555555555555'
  await store(ID, {
    title: 'Recipe', description: '', output: 'image', outputExt: 'webp',
    steps: { nodeId: '9', field: 'steps', high: 16 }, hasCover: false,
  }, {
    '9': { class_type: 'KSampler', inputs: { steps: 8, seed: 1 } },
  })
  const pin = { nodeId: '9', field: 'steps', high: 16 }
  assert.deepEqual((await listCustomWorkflows()).find(entry => entry.id === ID)?.steps, pin)
  assert.deepEqual((await loadCustomWorkflows())[`custom:${ID}`]?.steps, pin)
  const { loadCustomWorkflowsSync } = await import('../server/vendor/tool-comfy/custom-workflows.ts')
  assert.deepEqual(loadCustomWorkflowsSync()[`custom:${ID}`]?.steps, pin)
})

test('a malformed recipe does not reach the runner', async () => {
  const ID = '22222222-3333-4444-8555-666666666666'
  await store(ID, {
    title: 'Broken recipe', description: '', output: 'image', outputExt: 'webp',
    steps: { nodeId: '9', field: 'steps', high: 0 }, hasCover: false,
  }, { '9': { class_type: 'KSampler', inputs: { steps: 8 } } })
  assert.equal((await loadCustomWorkflows())[`custom:${ID}`]?.steps, undefined)
})

test('re-uploading the card with the same title keeps the recipe', async () => {
  const ID = '33333333-4444-4555-8666-777777777777'
  await store(ID, {
    title: 'Recipe to re-upload', description: '', output: 'image', outputExt: 'webp',
    steps: { nodeId: '9', field: 'steps', high: 16 }, hasCover: false,
  }, { '9': { class_type: 'KSampler', inputs: { steps: 8 } } })
  const saved = await saveCustomWorkflow({
    title: 'Recipe to re-upload',
    description: '',
    graph: { '9': { class_type: 'KSampler', inputs: { steps: 8 } } },
    output: 'image',
    outputExt: 'webp',
  })
  assert.equal(saved.id, ID)
  assert.deepEqual(saved.steps, { nodeId: '9', field: 'steps', high: 16 })
  assert.deepEqual((await listCustomWorkflows()).find(entry => entry.id === ID)?.steps,
    { nodeId: '9', field: 'steps', high: 16 })
})

test('a new graph without the steps node loses the recipe', async () => {
  const ID = '44444444-5555-4666-8777-888888888888'
  await store(ID, {
    title: 'Orphan recipe', description: '', output: 'image', outputExt: 'webp',
    steps: { nodeId: '9', field: 'steps', high: 16 }, hasCover: false,
  }, { '9': { class_type: 'KSampler', inputs: { steps: 8 } } })
  const saved = await saveCustomWorkflow({
    title: 'Orphan recipe',
    description: '',
    graph: { '9': { class_type: 'KSampler', inputs: { seed: 2 } } },
    output: 'image',
    outputExt: 'webp',
  })
  assert.equal(saved.steps, undefined)
})

test('the card list sees a meta changed on disk, and both loaders skip a card without its graph', async () => {
  const ID = '33333333-4444-4555-8666-777777777777'
  const graph = { '9': { class_type: 'KSampler', inputs: { steps: 8 } } }
  await store(ID, { title: 'Before', description: '', output: 'image', outputExt: 'webp', hasCover: false }, graph)
  assert.equal((await listCustomWorkflows()).find(entry => entry.id === ID)?.title, 'Before')
  // A longer title: the file's size changes, whatever the clock's resolution.
  await store(ID, { title: 'After the edit', description: '', output: 'image', outputExt: 'webp', hasCover: false }, graph)
  assert.equal((await listCustomWorkflows()).find(entry => entry.id === ID)?.title, 'After the edit')
  await rm(join(dataDir, 'custom-workflows', ID, 'graph.json'))
  assert.equal((await loadCustomWorkflows())[`custom:${ID}`], undefined)
  const { loadCustomWorkflowsSync } = await import('../server/vendor/tool-comfy/custom-workflows.ts')
  assert.equal(loadCustomWorkflowsSync()[`custom:${ID}`], undefined)
})
