/**
 * The agent's reading of a graph: a LoRA behind a word switch, the weights and
 * the sampler values it may change for one run, and the word a prompt must
 * keep. The fixture is neutral: the word "lanterna" switches a style LoRA on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ComfyGraph } from '../server/vendor/comfyui/index.ts'
import {
  droppedGateWords, planRunTweaks, readGraph, readingLines,
} from '../server/vendor/tool-comfy/graph-reading.ts'

/** A generation graph shaped like the personal ones: a switched LoRA, then two always-on LoRAs. */
function switchedGraph(): ComfyGraph {
  return {
    '51': { class_type: 'CLIPTextEncode', inputs: { text: ['73', 0], clip: ['56', 0] } },
    '52': { class_type: 'EmptyLatentImage', inputs: { width: 1080, height: 1920, batch_size: 1 } },
    '53': {
      class_type: 'KSampler',
      inputs: {
        seed: 1, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
        model: ['k2', 0], positive: ['51', 0], negative: ['51', 0], latent_image: ['52', 0],
      },
    },
    '55': { class_type: 'UNETLoader', inputs: { unet_name: 'base.safetensors', weight_dtype: 'default' } },
    '56': { class_type: 'CLIPLoader', inputs: { clip_name: 'clip.safetensors', type: 'krea2', device: 'default' } },
    '73': { class_type: 'PrimitiveStringMultiline', inputs: { value: '' } },
    '74': { class_type: 'StringContains', inputs: { string: ['73', 0], substring: 'lanterna', case_sensitive: false } },
    '76': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'styles\\lantern-glow.safetensors', strength_model: 0.6, model: ['55', 0] } },
    '78': { class_type: 'ComfySwitchNode', inputs: { switch: ['74', 0], on_false: ['55', 0], on_true: ['76', 0] } },
    k1: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'paper-texture.safetensors', strength_model: 0.15, model: ['78', 0] } },
    k2: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'film-look.safetensors', strength_model: 0.75, model: ['k1', 0] } },
  } as unknown as ComfyGraph
}

test('a LoRA behind a word switch is read with its word, the others as always on', () => {
  const reading = readGraph(switchedGraph(), '73')
  const lantern = reading.loras.find(lora => lora.node === '76')
  assert.equal(lantern?.name, 'lantern-glow')
  assert.equal(lantern?.gate?.word, 'lanterna')
  assert.equal(lantern?.gate?.when, 'contains')
  assert.equal(lantern?.gate?.readsPrompt, true)
  assert.equal(lantern?.strengthKey, '76.strength_model')
  // Downstream of the switch both sides run: these are not gated.
  assert.equal(reading.loras.find(lora => lora.node === 'k1')?.gate, undefined)
  assert.equal(reading.loras.find(lora => lora.node === 'k2')?.gate, undefined)
  assert.deepEqual(reading.size, { node: '52', width: 1080, height: 1920 })
  assert.equal(reading.sampler['53.steps'], 8)
  assert.equal(reading.takesImage, false)
  const lines = readingLines(reading).join('\n')
  assert.match(lines, /lantern-glow" weight 0\.6 \(fixed: not a run setting\), ON ONLY WHEN the prompt contains "lanterna"/)
  assert.match(lines, /film-look" weight 0\.75 \(fixed: not a run setting\), always on/)
  assert.match(lines, /takes no picture in/)
  // No tweak key is printed for a LoRA: it is not a run setting.
  assert.doesNotMatch(lines, /k2\.strength_model|76\.strength_model/)
})

test('a switch word the user wrote and the prompt lost is reported, case aside', () => {
  const reading = readGraph(switchedGraph(), '73')
  assert.deepEqual(droppedGateWords(reading, 'una donna in stile poster', 'Fai una Lanterna in stile poster'), ['lanterna'])
  assert.deepEqual(droppedGateWords(reading, 'una LANTERNA in stile poster', 'Fai una Lanterna in stile poster'), [])
  // A word the user never wrote is not forced into the prompt.
  assert.deepEqual(droppedGateWords(reading, 'un faro', 'disegna un faro'), [])
})

test('a run tweak may change a sampler value and never a LoRA, its file or a switch', () => {
  const graph = switchedGraph()
  const reserved = ['73', '53.seed']
  const fine = planRunTweaks(graph, { '53.steps': 12, '53.denoise': 0.9 }, reserved)
  assert.deepEqual(fine.errors, [])
  assert.deepEqual(fine.fields, { '53.steps': 12, '53.denoise': 0.9 })
  // The weight, the file and the switch word are the graph owner's.
  const lora = planRunTweaks(graph, { 'k2.strength_model': 0.3, '76.lora_name': 'other.safetensors' }, reserved)
  assert.equal(lora.errors.length, 2)
  assert.match(lora.errors[0] ?? '', /LoRA setting/)
  assert.match(lora.errors[0] ?? '', /never changes a LoRA from the chat/)
  assert.deepEqual(lora.fields, {})
  const gates = planRunTweaks(graph, { '74.substring': 'tramonto', '74.case_sensitive': true, '78.switch': 1 }, reserved)
  assert.equal(gates.errors.length, 3)
  assert.match(gates.errors[0] ?? '', /switch/)
  assert.deepEqual(gates.fields, {})
  // A class the packs spell another way is still a LoRA, through its inputs.
  const other = {
    '90': { class_type: 'LoadLora', inputs: { lora_name: 'a.safetensors', strength_model: 1, model: ['55', 0] } },
  } as unknown as ComfyGraph
  const renamed = planRunTweaks(other, { '90.strength_model': 0.1, '90.lora_name': 'b.safetensors' }, [])
  assert.equal(renamed.errors.length, 2)
  assert.deepEqual(renamed.fields, {})
  // A weight or a file read from a text or number node is the LoRA's too.
  const indirect = {
    '90': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: ['91', 0], strength_model: ['92', 0], model: ['55', 0] } },
    '91': { class_type: 'PrimitiveString', inputs: { value: 'a.safetensors' } },
    '92': { class_type: 'PrimitiveFloat', inputs: { value: 0.5 } },
  } as unknown as ComfyGraph
  const through = planRunTweaks(indirect, { '91.value': 'b.safetensors', '92.value': 1.2 }, [])
  assert.equal(through.errors.length, 2)
  assert.deepEqual(through.fields, {})
  // The prompt and the seed stay the studio's, as before.
  const wrong = planRunTweaks(graph, { '53.cfg': 'forte', '99.cfg': 2, 'k2.model': 1, '73.value': 'altro', '53.seed': 4 }, reserved)
  assert.equal(wrong.errors.length, 5)
  assert.deepEqual(wrong.fields, {})
  // The node's bounds are checked when ComfyUI described them.
  const bounded = planRunTweaks(graph, { '53.steps': 999 }, ['73', '53.seed'], [
    { node: '53', field: 'steps', kind: 'number', min: 1, max: 100 },
  ] as never)
  assert.equal(bounded.errors.length, 1)
})
