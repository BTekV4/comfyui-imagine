/**
 * `runWorkflow` asks ComfyUI whether the graph can run before it uploads the
 * input files, and submits the same graph it always did: the uploaded names
 * in their nodes, the substituted model names in theirs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImagineHost } from '../server/src/host.ts'
import type { ComfyGraph } from '../server/vendor/comfyui/index.ts'
import { runWorkflow, type LoadedWorkflow } from '../server/vendor/tool-comfy/index.ts'
import { configureComfySetup } from '../server/vendor/tool-comfy/comfy-setup.ts'

const GRAPH: ComfyGraph = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'krea2_turbo_int8_convrot.safetensors' } },
  '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
  '3': { class_type: 'VHS_LoadVideo', inputs: { video: 'placeholder.mp4' } },
  '4': { class_type: 'LoadImage', inputs: { image: 'card.png' } },
}

/** A fake ComfyUI that records the order of the calls and the graph it was sent. */
function fakeHost(ready: boolean) {
  const events: string[] = []
  let submitted: ComfyGraph | undefined
  const host = {
    comfy: {
      setupCall: async (_route: string, body: { prompt: ComfyGraph }) => {
        events.push('check')
        // The check sees the model names, not upload names it could not know yet.
        assert.equal(body.prompt['1']?.inputs.unet_name, 'krea2_turbo_int8_convrot.safetensors')
        return ready
          ? { ready: true, packs: [], models: [], bytes: 0, unknownClasses: [], unknownFiles: [], substitutions: { 'krea2_turbo_int8_convrot.safetensors': 'krea2_turbo_nvfp4.safetensors' } }
          : { ready: false, packs: [], models: [], bytes: 0, unknownClasses: ['Missing'], unknownFiles: [] }
      },
      uploadImage: async (name: string) => { events.push(`upload ${name}`); return { name: `up-${name}`, subfolder: '', type: 'input' } },
      uploadVideo: async (name: string) => { events.push(`upload ${name}`); return { name: `up-${name}`, subfolder: '', type: 'input' } },
      run: async (graph: ComfyGraph) => { events.push('run'); submitted = graph; return { promptId: 'p', media: [] } },
    },
  } as unknown as ImagineHost
  return { host, events, submitted: () => submitted }
}

const WORKFLOW = {
  graph: GRAPH, imageNodeId: '2', videoNodeId: '3', videoField: 'video',
} as unknown as LoadedWorkflow

const INPUTS = {
  inputImage: { name: 'photo.png', bytes: new Uint8Array([1]) },
  inputVideo: { name: 'clip.mp4', bytes: new Uint8Array([2]) },
  customFiles: [{ node: '4', kind: 'image' as const, name: 'extra.png', bytes: new Uint8Array([3]) }],
}

test('the check comes before the uploads, and the graph sent carries both', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: false }), 5)
  const fake = fakeHost(true)
  const outputDir = await mkdtemp(join(tmpdir(), 'imagine-run-'))
  await runWorkflow(fake.host, WORKFLOW, outputDir, {}, INPUTS)
  assert.equal(fake.events[0], 'check')
  assert.deepEqual(fake.events.slice(1, 4).sort(), ['upload clip.mp4', 'upload extra.png', 'upload photo.png'])
  assert.equal(fake.events[4], 'run')
  const graph = fake.submitted()
  assert.equal(graph?.['1']?.inputs.unet_name, 'krea2_turbo_nvfp4.safetensors')
  assert.equal(graph?.['2']?.inputs.image, 'up-photo.png')
  assert.equal(graph?.['3']?.inputs.video, 'up-clip.mp4')
  assert.equal(graph?.['4']?.inputs.image, 'up-extra.png')
  // The loaded graph is never touched.
  assert.equal(GRAPH['2']?.inputs.image, 'placeholder.png')
})

test('a graph ComfyUI cannot run uploads nothing', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: false }), 5)
  const fake = fakeHost(false)
  const outputDir = await mkdtemp(join(tmpdir(), 'imagine-run-'))
  await assert.rejects(runWorkflow(fake.host, WORKFLOW, outputDir, {}, INPUTS))
  assert.deepEqual(fake.events, ['check'])
})

test('a pin that does not resolve fails before the check and the uploads', async () => {
  const fake = fakeHost(true)
  const outputDir = await mkdtemp(join(tmpdir(), 'imagine-run-'))
  const broken = { ...WORKFLOW, imageNodeId: '99' } as unknown as LoadedWorkflow
  await assert.rejects(runWorkflow(fake.host, broken, outputDir, {}, INPUTS), /no node at 99/)
  assert.deepEqual(fake.events, [])
})
