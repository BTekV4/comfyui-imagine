/**
 * The reference photo of an edit, found from the graph and not only from the
 * config.
 *
 * `refImageNodeId` / `refEncodeNodeId` arrived on 2026-11-15. An installation
 * whose `config.yaml` predates them still had the shipped branch in the graph,
 * and the edit was submitted with a `reference.png` nobody uploaded: ComfyUI
 * refused the run. These tests cover the three ways out — the graph's own
 * second-image inputs, the example's defaults for an included graph, and an
 * explicit config pin that wins over both — plus what the user is told about
 * a config older than the example.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImagineHost } from '../server/src/host.ts'
import type { ComfyGraph } from '../server/vendor/comfyui/index.ts'
import { runWorkflow, type LoadedWorkflow } from '../server/vendor/tool-comfy/index.ts'
import { configureComfySetup } from '../server/vendor/tool-comfy/comfy-setup.ts'
import { detectRefBranch, dropRefBranch } from '../server/vendor/tool-comfy/ref-branch.ts'
import { loadWorkflows, workflowGaps } from '../server/vendor/tool-comfy/workflow-load.ts'
import { graphEditor, workflowInventory } from '../server/vendor/tool-comfy/workflow-inventory.ts'
import { writableOverlay } from '../server/vendor/tool-comfy/workflow-overlay.ts'

/** One API-format graph, read from the repository. */
function graphOf(file: string): ComfyGraph {
  return JSON.parse(readFileSync(`workflows/${file}`, 'utf8')) as ComfyGraph
}

/** The graph a run was handed, and the images it uploaded. */
function fakeRun() {
  let submitted: ComfyGraph | undefined
  const uploaded: string[] = []
  const host = {
    comfy: {
      setupCall: async () => ({
        ready: true, packs: [], models: [], bytes: 0, unknownClasses: [], unknownFiles: [], substitutions: {},
      }),
      uploadImage: async (name: string) => {
        uploaded.push(name)
        return { name, subfolder: '', type: 'input' }
      },
      run: async (graph: ComfyGraph) => {
        submitted = graph
        return { promptId: 'p', media: [] }
      },
    },
  } as unknown as ImagineHost
  return { host, submitted: () => submitted, uploaded }
}

test('both shipped edit graphs name the same reference branch', () => {
  for (const file of ['comfyui_edit_krea2_API.json', 'comfyui_edit_krea2_region_API.json']) {
    assert.deepEqual(detectRefBranch(graphOf(file)), { refImageNodeId: '77', refEncodeNodeId: '78' }, file)
  }
  // A text-to-image graph has no second photo.
  assert.equal(detectRefBranch(graphOf('comfyui_generazione_krea2_API.json')), undefined)
})

test('a config written before the pins existed still gets the reference branch', () => {
  const { byRun } = loadWorkflows({
    editImage: { path: 'workflows/comfyui_edit_krea2_API.json' },
    editImageRegion: { path: 'workflows/comfyui_edit_krea2_region_API.json' },
  } as never)
  const graphs = byRun as unknown as Record<string, LoadedWorkflow>
  assert.equal(graphs.edit?.refImageNodeId, '77')
  assert.equal(graphs.edit?.refEncodeNodeId, '78')
  assert.equal(graphs.editRegion?.refImageNodeId, '77')
  assert.equal(graphs.editRegion?.refEncodeNodeId, '78')
})

test('a graph whose branch is not recognisable takes the example defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'imagine-ref-fallback-'))
  const file = join(root, 'graph.json')
  // The two nodes are there, but no `source_latent_b`/`image_b` link says they
  // are the reference: only the example knows the ids.
  writeFileSync(file, JSON.stringify({
    '9': { class_type: 'KSampler', inputs: { seed: 1 } },
    '77': { class_type: 'LoadImage', inputs: { image: 'reference.png' } },
    '78': { class_type: 'VAEEncode', inputs: { pixels: ['77', 0] } },
  }))
  const { byRun } = loadWorkflows(
    { editImage: { path: file } } as never,
    undefined,
    { editImage: { path: file, refImageNodeId: '77', refEncodeNodeId: '78' } } as never,
  )
  const loaded = (byRun as unknown as Record<string, LoadedWorkflow>).edit!
  assert.equal(loaded.refImageNodeId, '77')
  assert.equal(loaded.refEncodeNodeId, '78')
})

test('an explicit pin wins over the branch the graph shows', () => {
  const root = mkdtempSync(join(tmpdir(), 'imagine-ref-explicit-'))
  const file = join(root, 'graph.json')
  writeFileSync(file, JSON.stringify({
    '76': { class_type: 'LoadImage', inputs: { image: 'photo.png' } },
    '77': { class_type: 'LoadImage', inputs: { image: 'reference.png' } },
    '78': { class_type: 'VAEEncode', inputs: { pixels: ['77', 0] } },
    '79': { class_type: 'LoadImage', inputs: { image: 'mine.png' } },
    '80': { class_type: 'VAEEncode', inputs: { pixels: ['79', 0] } },
    '300': { class_type: 'Krea2EditModelPatch', inputs: { source_latent: ['78', 0], source_latent_b: ['80', 0] } },
  }))
  const { byRun } = loadWorkflows({
    editImage: { path: file, refImageNodeId: '79', refEncodeNodeId: '80' },
  } as never)
  const loaded = (byRun as unknown as Record<string, LoadedWorkflow>).edit!
  assert.equal(loaded.refImageNodeId, '79')
  assert.equal(loaded.refEncodeNodeId, '80')
})

test('with no reference the branch leaves the graph; with one the photo lands in its loader', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: false }), 5)
  const outputDir = await mkdtemp(join(tmpdir(), 'imagine-ref-run-'))
  const { byRun } = loadWorkflows({ editImage: { path: 'workflows/comfyui_edit_krea2_API.json' } } as never)
  const workflow = (byRun as unknown as Record<string, LoadedWorkflow>).edit!

  const plain = fakeRun()
  await runWorkflow(plain.host, workflow, outputDir, {}, {})
  const graph = plain.submitted()!
  assert.equal(graph['77'], undefined, 'the reference loader stayed in a run that had no reference')
  assert.equal(graph['78'], undefined, 'the reference encoder stayed in a run that had no reference')
  assert.equal(graph['303']?.inputs['source_latent_b'], undefined)
  assert.equal(graph['304']?.inputs['image_b'], undefined)
  assert.equal(graph['305']?.inputs['image_b'], undefined)
  // The photo being edited is untouched.
  assert.equal(graph['76']?.class_type, 'LoadImage')

  const withRef = fakeRun()
  await runWorkflow(withRef.host, workflow, outputDir, {}, {
    refImage: { bytes: new Uint8Array([1, 2, 3]), name: 'neutral-reference.png' },
  })
  assert.deepEqual(withRef.uploaded, ['neutral-reference.png'])
  assert.equal(withRef.submitted()?.['77']?.inputs['image'], 'neutral-reference.png')
})

test('the config gaps are the example keys the live entry lacks', () => {
  const live = { editImage: { path: 'workflows/comfyui_edit_krea2_API.json', outputExt: 'png' } }
  const example = {
    editImage: {
      path: 'workflows/comfyui_edit_krea2_API.json',
      refImageNodeId: '77',
      refEncodeNodeId: '78',
      outputExt: 'png',
      promptNodeId: '500',
      description: 'not a run value',
    },
  }
  const gaps = workflowGaps(live as never, example as never)
  assert.deepEqual(gaps, [{ configKey: 'editImage', fields: ['refImageNodeId', 'refEncodeNodeId', 'promptNodeId'] }])

  // A different graph is not an old copy of the example's: no gap is invented.
  assert.deepEqual(workflowGaps({ editImage: { path: 'workflows/mine.json' } } as never, example as never), [])
  // A complete entry has nothing to report.
  const complete = { editImage: { ...example.editImage, refImageNodeId: '77', refEncodeNodeId: '78', promptNodeId: '500' } }
  assert.deepEqual(workflowGaps(complete as never, example as never), [])
})

test('the settings page lists the missing keys with the stale pins', () => {
  const { rows } = loadWorkflows(
    { editImage: { path: 'workflows/comfyui_edit_krea2_API.json' } } as never,
    undefined,
    { editImage: { path: 'workflows/comfyui_edit_krea2_API.json', refImageNodeId: '77', refEncodeNodeId: '78' } } as never,
  )
  const editor = graphEditor(function* () {})
  const { inventory } = workflowInventory(
    {} as ImagineHost,
    rows,
    editor,
    writableOverlay,
    () => [],
    new Map([['editImage', ['refImageNodeId', 'refEncodeNodeId']]]),
  )
  const warnings = inventory.warnings('edit') ?? []
  assert.ok(warnings.some(line => line.includes('refImageNodeId, refEncodeNodeId')), warnings.join(' | '))
})

test('a reference branch that took the sampler\'s conditioning leaves the graph as it was', () => {
  /*
   * A generation graph whose positive is groomed with a reference picture
   * (Krea 2's own reference encoder) and whose own text encode is still in the
   * file, unread. Without a reference the branch goes and the sample falls back
   * to that encode: the picture is the one the graph made before the branch.
   */
  const graph: ComfyGraph = {
    '73': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'a bicycle' } },
    '51': { class_type: 'CLIPTextEncode', inputs: { text: ['73', 0], clip: ['56', 0] } },
    'ref-load': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
    'ref-enc': { class_type: 'Krea2EditGroundedEncode', inputs: { clip: ['56', 0], prompt: ['73', 0], image: ['ref-load', 0] } },
    '53': { class_type: 'KSampler', inputs: { model: ['55', 0], positive: ['ref-enc', 0], negative: ['58', 0], latent_image: ['52', 0] } },
  } as unknown as ComfyGraph
  dropRefBranch(graph, 'ref-load', 'ref-enc', '73')
  assert.equal(graph['ref-load'], undefined, 'the loader went')
  assert.equal(graph['ref-enc'], undefined, 'the encoder went')
  assert.deepEqual(graph['53']?.inputs['positive'], ['51', 0], 'the sample is groomed by the graph\'s own text encode again')
  assert.deepEqual(graph['51']?.inputs['text'], ['73', 0], 'the prompt still reaches it')
})

test('a branch nothing else can stand in for is left unwired, not guessed', () => {
  // The reference encoder took the model input, not the conditioning: there is
  // no stand-in for a model, so the field is simply gone.
  const graph: ComfyGraph = {
    '73': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'a bicycle' } },
    'ref-load': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
    'ref-patch': { class_type: 'Krea2EditModelPatch', inputs: { model: ['55', 0], source_latent: ['ref-load', 0] } },
    '53': { class_type: 'KSampler', inputs: { model: ['ref-patch', 0], positive: ['51', 0], latent_image: ['52', 0] } },
  } as unknown as ComfyGraph
  dropRefBranch(graph, 'ref-load', 'ref-patch', '73')
  assert.equal(graph['ref-patch'], undefined)
  assert.equal(graph['53']?.inputs['model'], undefined, 'nothing is invented for a model')
  assert.deepEqual(graph['53']?.inputs['positive'], ['51', 0], 'a link into the branch and nothing else is untouched')
})
