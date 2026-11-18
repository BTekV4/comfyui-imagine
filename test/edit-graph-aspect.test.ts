/**
 * The Krea 2 edit graphs draw on the photo's own canvas.
 *
 * The studio used to hand the edit a studio ratio from the composer, and a
 * 4:5 photo came back cropped on a 3:4 canvas. The graphs in `workflows/` are
 * the other half of the fix: the latent is measured from the scaled source
 * (`GetImageSize`), and the zone graph stitches the inpainted crop back into
 * the original picture. This test reads the shipped graphs and fails if a
 * fixed canvas ever comes back, or if the zone graph stops compositing on the
 * source.
 *
 * It is a structural test on purpose: no ComfyUI, no GPU — the graph itself
 * is the contract.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImagineHost } from '../server/src/host.ts'
import type { ComfyGraph } from '../server/vendor/comfyui/index.ts'
import { runWorkflow, type LoadedWorkflow } from '../server/vendor/tool-comfy/index.ts'
import { configureComfySetup } from '../server/vendor/tool-comfy/comfy-setup.ts'

/** One API-format graph, as ComfyUI reads it. */
type Graph = Record<string, { readonly class_type?: string; readonly inputs?: Record<string, unknown> }>

function graphOf(file: string): Graph {
  return JSON.parse(readFileSync(`workflows/${file}`, 'utf8')) as Graph
}

/** A link (`[node, output]`), as the API format writes it. */
function link(value: unknown): [string, number] | undefined {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number'
    ? [value[0], value[1]]
    : undefined
}

/** The node of a class, or a failure naming the file. */
function nodeOf(graph: Graph, type: string, file: string): [string, Graph[string]] {
  const found = Object.entries(graph).find(([, node]) => node.class_type === type)
  assert.ok(found !== undefined, `${file} has no ${type} node`)
  return found
}

test('the edit graph measures its latent from the source photo', () => {
  const file = 'comfyui_edit_krea2_API.json'
  const graph = graphOf(file)
  const [latentId, latent] = nodeOf(graph, 'EmptySD3LatentImage', file)
  const width = link(latent.inputs?.['width'])
  const height = link(latent.inputs?.['height'])
  assert.ok(width !== undefined && height !== undefined, `${file}: the latent has a fixed size again`)
  assert.equal(width[0], height[0], `${file}: width and height come from different nodes`)
  const [sizeId, size] = nodeOf(graph, 'GetImageSize', file)
  assert.equal(width[0], sizeId, `${file}: the latent is not measured from GetImageSize`)
  const scaled = link(size.inputs?.['image'])
  assert.ok(scaled !== undefined, `${file}: GetImageSize does not read a picture`)
  assert.equal(graph[scaled[0]]?.class_type, 'ImageScaleToTotalPixels', `${file}: the size is not read off the scaled source`)
  // The scaling keeps the ratio and only moves the pixel budget.
  const scale = graph[scaled[0]]
  assert.equal(typeof scale?.inputs?.['megapixels'], 'number', `${file}: the scaling has no pixel budget`)
  // The sampler's latent is that measured latent, not a second one.
  const [samplerId, sampler] = nodeOf(graph, 'KSampler', file)
  assert.deepEqual(link(sampler.inputs?.['latent_image']), [latentId, 0], `${file}: ${samplerId} does not sample the measured latent`)
})

test('the zone graph puts the inpainted crop back on the source canvas', () => {
  const file = 'comfyui_edit_krea2_region_API.json'
  const graph = graphOf(file)
  const [, stitch] = nodeOf(graph, 'ImagineInpaintStitch', file)
  const [cropId] = nodeOf(graph, 'ImagineInpaintCrop', file)
  assert.deepEqual(link(stitch.inputs?.['stitch']), [cropId, 0], `${file}: the stitch does not read the crop`)
  const [compositeId, composite] = nodeOf(graph, 'ImageCompositeMasked', file)
  // The destination is the original photo: outside the zone nothing is
  // regenerated, and the result is the photo's own size.
  const source = link(composite.inputs?.['destination'])
  assert.ok(source !== undefined, `${file}: the composite has no destination`)
  assert.equal(graph[source[0]]?.class_type, 'LoadImage', `${file}: the composite does not keep the source photo`)
  assert.equal(composite.inputs?.['resize_source'], false, `${file}: the composite resizes the source, which can crop it`)
  assert.ok(link(composite.inputs?.['source']) !== undefined, `${file}: the composite has no inpainted source`)
  assert.ok(compositeId.length > 0)
})

/** A graph whose latent is measured from the picture, as the edit graph is. */
const MEASURED = {
  '76': { class_type: 'LoadImage', inputs: { image: 'photo.png' } },
  '400': { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['76', 0], megapixels: 1.9 } },
  '401': { class_type: 'GetImageSize', inputs: { image: ['400', 0] } },
  '306': { class_type: 'EmptySD3LatentImage', inputs: { width: ['401', 0], height: ['401', 1], batch_size: 1 } },
  '307': { class_type: 'KSampler', inputs: { latent_image: ['306', 0], seed: 1, steps: 8 } },
} as unknown as ComfyGraph

/** A fake ComfyUI that records the graph it was handed. */
function fakeRun() {
  let submitted: ComfyGraph | undefined
  const host = {
    comfy: {
      setupCall: async () => ({ ready: true, packs: [], models: [], bytes: 0, unknownClasses: [], unknownFiles: [], substitutions: {} }),
      run: async (graph: ComfyGraph) => {
        submitted = graph
        return { promptId: 'p', media: [] }
      },
    },
  } as unknown as ImagineHost
  return { host, submitted: () => submitted }
}

test('a size nobody asked for leaves the measured latent alone; a named ratio writes it', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: false }), 5)
  const outputDir = await mkdtemp(join(tmpdir(), 'imagine-edit-canvas-run-'))
  const workflow = { graph: MEASURED } as unknown as LoadedWorkflow

  const unasked = fakeRun()
  await runWorkflow(unasked.host, workflow, outputDir, { size: '1080x1080' }, {})
  assert.deepEqual(unasked.submitted()?.['306']?.inputs.width, ['401', 0], 'a size nobody asked for replaced the measurement')
  assert.deepEqual(unasked.submitted()?.['306']?.inputs.height, ['401', 1])

  const asked = fakeRun()
  await runWorkflow(asked.host, workflow, outputDir, { size: '1080x1080', canvasAsked: true }, {})
  assert.equal(asked.submitted()?.['306']?.inputs.width, 1080, 'the ratio the user named was not written')
  assert.equal(asked.submitted()?.['306']?.inputs.height, 1080)
  // The loaded graph is never touched.
  assert.deepEqual(MEASURED['306']?.inputs.width, ['401', 0])
})
