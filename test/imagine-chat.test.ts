/**
 * The written lane, read with a fake model: which run a sentence becomes, when
 * the workflow gateway opens, how long a clip really is, and what the lane
 * refuses instead of queueing.
 *
 * The reading is one text call (two when a graph is being changed), so a fake
 * host that answers with fixed JSON exercises everything between the sentence
 * and the intents: the action table, the ladders, the closed lists the
 * workflows accept and the graphs this deployment actually has. No model, no
 * GPU, no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readImagineChat, type ImagineChatRequest, type WorkflowCard, type WorkflowInventory, type WorkflowSummary,
} from '../server/vendor/tool-comfy/imagine-chat.ts'
import { planWorkflowPatch } from '../server/vendor/tool-comfy/workflow-edit.ts'
import { MUSIC_MAX_SECONDS, MUSIC_MIN_SECONDS } from '../server/vendor/tool-comfy/music-prompt.ts'
import { MAX_STORY_SECONDS } from '../shared/imagine-media.ts'
import { IMAGINE_ACTIONS } from '../shared/imagine-types.ts'
import type { ImagineHost } from '../server/src/host.ts'
import type { ComfyGraph } from '../server/vendor/comfyui/index.ts'
import type { WorkflowFieldFact } from '../shared/imagine-chat.ts'

/** The model the reading is asked to use, so a route exists without config. */
const MODEL = { provider: 'fake', model: 'fake' } as const

/** A host whose text model answers with the given replies, in order. */
function hostSaying(...replies: readonly string[]): ImagineHost & { readonly prompts: string[] } {
  const prompts: string[] = []
  let index = 0
  const host = {
    llm: {
      async *stream(options: { messages: readonly { content: readonly { text?: string }[] }[] }) {
        const text = options.messages[0]?.content[0]?.text ?? ''
        prompts.push(text)
        const reply = replies[Math.min(index, replies.length - 1)] ?? ''
        index += 1
        yield { type: 'text-delta', text: reply }
      },
    },
  }
  return Object.assign(host as unknown as ImagineHost, { prompts })
}

/** A graph with one numeric input and one combo, enough to be refused on. */
const GRAPH = {
  '53': { class_type: 'KSampler', inputs: { steps: 8, seed: 1 } },
  '276': { class_type: 'LoadLora', inputs: { lora_name: 'a.safetensors', strength_model: 1 } },
} as unknown as ComfyGraph

/** What ComfyUI says those two inputs accept. */
const FACTS: readonly WorkflowFieldFact[] = [
  { node: '53', field: 'steps', kind: 'number', min: 1, max: 100, step: 1 },
  { node: '276', field: 'lora_name', kind: 'combo', options: ['a.safetensors', 'b.safetensors'] },
]

/** The workflows a reading may be told about, unless a test says otherwise. */
const LIST: readonly WorkflowSummary[] = [
  { key: 'generate', label: 'image generation', file: 'generate.json', run: 'generate', description: 'Draw a new photo from a sentence.' },
  { key: 'edit', label: 'image editing', file: 'edit.json', run: 'edit' },
  { key: 'video', label: 'image → video', file: 'video.json', run: 'video' },
  { key: 'music', label: 'music generation', file: 'music.json', run: 'generateMusic' },
  { key: 'video-song', label: 'clip on a song', file: 'song.json', run: 'videoOnSong' },
]

/** The personal card a sentence may run, with one exposed input. */
const CARD: WorkflowCard = {
  id: '11111111-2222-3333-4444-555555555555',
  title: 'Lookbook',
  description: 'A catalogue of outfits: pick one and it draws it.',
  inputs: [{ node: '276', field: 'title', label: 'Outfit', kind: 'combo', value: 'Red' }],
}

/** What every test uses when it does not care about the inventory. */
function inventoryOf(over: Partial<WorkflowInventory> = {}): WorkflowInventory {
  return {
    list: LIST,
    cards: [],
    summarise: () => '53 KSampler: steps=8, seed=1',
    fields: () => [
      { node: '53', classType: 'KSampler', field: 'steps', value: 8, kind: 'number' },
      { node: '276', classType: 'LoadLora', field: 'lora_name', value: 'a.safetensors', kind: 'text' },
    ],
    facts: () => Promise.resolve(FACTS),
    warnings: () => [],
    overridden: () => false,
    options: () => Promise.resolve(undefined),
    plan: (key, changes, facts) => ({
      file: `${key}.json`,
      ...planWorkflowPatch(GRAPH, changes, new Map((facts ?? []).map(fact => [`${fact.node}.${fact.field}`, fact]))),
      warnings: [],
    }),
    ...over,
  }
}

/** One request with the model a test fake answers on. */
function ask(text: string, extra: Partial<ImagineChatRequest> = {}): ImagineChatRequest {
  return { text, model: MODEL, ...extra }
}

test('a sentence becomes the run the action table knows', async () => {
  const host = hostSaying(JSON.stringify({
    reply: 'A twelve-second clip of the photo.',
    intents: [{ action: 'video', prompt: 'a cat walks across the table', source: 'cat.png', seconds: 12 }],
  }))
  const answer = await readImagineChat(host, ask('anima questa foto per dodici secondi', {
    staged: [{ name: 'cat.png', kind: 'image' }],
  }), inventoryOf())
  assert.equal(answer.read, true)
  assert.equal(answer.intents.length, 1)
  assert.equal(answer.intents[0]?.action, 'video')
  assert.equal(answer.intents[0]?.source, 'cat.png')
  // Twelve seconds is off the single-clip rungs and becomes a chain at the
  // same length, not the ten-second clip it used to fall back to.
  assert.equal(answer.intents[0]?.seconds, 12)
  assert.match(answer.reply, /twelve-second/)
})

test('every action the chat may queue has its own bullet, compose and custom included', async () => {
  const host = hostSaying(JSON.stringify({ reply: 'ok', intents: [] }))
  await readImagineChat(host, ask('ciao'), inventoryOf())
  const instruction = host.prompts[0] ?? ''
  for (const action of IMAGINE_ACTIONS) {
    // scanFrame is the half of «Recreate video» that stops for a click; the
    // written lane deliberately queues the whole recipe instead.
    if (action === 'scanFrame') continue
    assert.ok(instruction.includes(`- ${action}:`), `the instruction has no line for ${action}`)
  }
  // The durations in the prompt are the studio's own ceilings, not older copies.
  assert.ok(instruction.includes(`20-${String(MAX_STORY_SECONDS)} seconds`), 'the story length is not the chain ceiling')
  assert.ok(instruction.includes(`${String(MUSIC_MIN_SECONDS)}-${String(MUSIC_MAX_SECONDS)}`), 'the music length is not the graph’s range')
})

test('the workflow gateway stays shut when the sentence is not about a graph', async () => {
  const host = hostSaying(JSON.stringify({
    reply: 'Here is the photo.',
    workflow: 'generate',
    intents: [{ action: 'generate', prompt: 'a red bicycle' }],
  }))
  const answer = await readImagineChat(host, ask('fammi una foto di una bici rossa'), inventoryOf())
  assert.equal(host.prompts.length, 1, 'a second pass ran for an ordinary request')
  assert.equal(answer.proposal, undefined)
  assert.equal(answer.intents.length, 1)
})

test('an explicit request about a graph runs the second pass and keeps the intents', async () => {
  const host = hostSaying(
    JSON.stringify({
      reply: 'I will change it.',
      workflow: 'generate',
      // The prompt is left to the sentence on purpose: the runs of the first
      // pass keep the same fixes they get without a proposal.
      intents: [{ action: 'generate', prompt: '' }],
    }),
    JSON.stringify({ reply: 'Done.', changes: [{ node: '53', field: 'steps', value: 20 }] }),
  )
  const answer = await readImagineChat(host, ask('cambia a 20 gli step del workflow di generazione, e intanto fammi un faro'), inventoryOf())
  assert.equal(host.prompts.length, 2)
  assert.equal(answer.proposal?.key, 'generate')
  assert.deepEqual(answer.proposal?.diff.map(row => [row.node, row.field, row.to]), [['53', 'steps', 20]])
  // The run the same sentence asked for is not thrown away for the graph, and
  // an empty prompt takes the line the user wrote.
  assert.deepEqual(answer.intents.map(intent => intent.action), ['generate'])
  assert.match(answer.intents[0]?.prompt ?? '', /cambia a 20 gli step/)
  const second = host.prompts[1] ?? ''
  assert.ok(second.includes('range 1..100'), 'the second pass was not told the number’s bounds')
  assert.ok(second.includes('a.safetensors'), 'the second pass was not told the combo’s values')
})

test('a value outside the closed list or the bounds is refused, not proposed', async () => {
  const host = hostSaying(
    JSON.stringify({ reply: 'Sure.', workflow: 'generate' }),
    JSON.stringify({
      reply: 'Here it is.',
      changes: [
        { node: '276', field: 'lora_name', value: 'invented.safetensors' },
        { node: '53', field: 'steps', value: 1000 },
      ],
    }),
  )
  const answer = await readImagineChat(host, ask('metti la lora invented e porta gli step a 1000 nel workflow'), inventoryOf())
  assert.equal(answer.proposal, undefined)
  assert.equal(answer.intents.length, 0)
  assert.match(answer.reply, /invented\.safetensors/)
  assert.match(answer.reply, /1000/)
})

test('a measure off the grid is moved onto a valid multiple', async () => {
  const offGrid: readonly WorkflowFieldFact[] = [
    { node: '53', field: 'steps', kind: 'number', min: 1, max: 4096, step: 8 },
  ]
  const host = hostSaying(
    JSON.stringify({ reply: 'Ok.', workflow: 'generate' }),
    JSON.stringify({ reply: 'Set.', changes: [{ node: '53', field: 'steps', value: 1003 }] }),
  )
  const answer = await readImagineChat(host, ask('porta gli step del workflow a 1003'), inventoryOf({ facts: () => Promise.resolve(offGrid) }))
  assert.equal(answer.proposal?.diff[0]?.to, 1000)
})

test('a personal card runs as custom, with its own inputs, and an unknown one is refused', async () => {
  const inventory = inventoryOf({ cards: [CARD] })
  const host = hostSaying(JSON.stringify({
    reply: 'Running the lookbook.',
    intents: [{
      action: 'custom',
      prompt: 'a red coat',
      customWorkflowId: CARD.id,
      customFields: { '276.title': 'Red coat' },
    }],
  }))
  const answer = await readImagineChat(host, ask('usa la card Lookbook e disegna il cappotto rosso'), inventory)
  assert.equal(answer.intents.length, 1)
  assert.equal(answer.intents[0]?.customWorkflowId, CARD.id)
  assert.deepEqual(answer.intents[0]?.customFields, { '276.title': 'Red coat' })

  const missing = hostSaying(JSON.stringify({
    reply: 'Running it.',
    intents: [{ action: 'custom', prompt: 'x', customWorkflowId: 'not-a-card' }],
  }))
  const refused = await readImagineChat(missing, ask('usa la card che non esiste'), inventoryOf({ cards: [CARD] }))
  assert.equal(refused.intents.length, 0)
  assert.match(refused.reply, /not-a-card/)
})

test('a run whose graph is not configured is said, not queued', async () => {
  const host = hostSaying(JSON.stringify({
    reply: 'Composing the two photos.',
    intents: [{ action: 'compose', prompt: 'the red dress', source: 'a.png', reference: 'b.png' }],
  }))
  const answer = await readImagineChat(host, ask('metti questo vestito su questa persona', {
    staged: [{ name: 'a.png', kind: 'image' }, { name: 'b.png', kind: 'image' }],
  }), inventoryOf({ list: LIST.filter(entry => entry.run === 'generate') }))
  assert.equal(answer.intents.length, 0)
  assert.match(answer.reply, /compose/)
})

test('a duration past the chain’s ceiling is the ceiling, and the reply says so', async () => {
  const host = hostSaying(JSON.stringify({
    reply: 'A five-minute story.',
    intents: [{ action: 'story', prompt: 'a long walk', seconds: 400 }],
  }))
  const answer = await readImagineChat(host, ask('fammi un video di quattrocento secondi'), inventoryOf())
  assert.equal(answer.intents[0]?.seconds, MAX_STORY_SECONDS)
  assert.match(answer.reply, new RegExp(String(MAX_STORY_SECONDS)))
})

test('a song below the writer’s floor is raised to it', async () => {
  const host = hostSaying(JSON.stringify({
    reply: 'A short song.',
    intents: [{ action: 'music', prompt: 'a folk song', lyrics: 'la la', seconds: 10 }],
  }))
  const answer = await readImagineChat(host, ask('fammi una canzone di dieci secondi'), inventoryOf())
  assert.equal(answer.intents[0]?.seconds, MUSIC_MIN_SECONDS)
})

test('the quality pill, the upscale target and a precise edit travel as intents', async () => {
  const host = hostSaying(JSON.stringify({
    reply: 'Three runs.',
    intents: [
      { action: 'generate', prompt: 'a portrait', quality: 'high' },
      { action: 'upscale', prompt: '', source: 'photo.png', upscaleTo: 1440 },
      { action: 'remix', prompt: 'make the jacket leather', source: 'photo.png', region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
    ],
  }))
  const answer = await readImagineChat(host, ask('alta qualità, poi upscale a 1440, e cambia solo la giacca'), inventoryOf({
    list: [...LIST, { key: 'upscale-image', label: 'image upscale', file: 'up.json', run: 'upscaleImage' }, { key: 'edit-region', label: 'precise edit', file: 'r.json', run: 'editRegion' }],
  }), undefined)
  assert.equal(answer.intents[0]?.quality, 'high')
  assert.equal(answer.intents[1]?.upscaleTo, 1440)
  assert.deepEqual(answer.intents[2]?.region, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 })
})

test('a precise edit zone outside the photo is dropped, not sent', async () => {
  const host = hostSaying(JSON.stringify({
    reply: 'Editing the zone.',
    intents: [{ action: 'remix', prompt: 'sharpen it', source: 'photo.png', region: { x: 0.8, y: 0.2, w: 0.5, h: 0.4 } }],
  }))
  const answer = await readImagineChat(host, ask('cambia la zona in alto a destra'), inventoryOf())
  assert.equal(answer.intents[0]?.region, undefined)
})

test('the reading is told when a workflow applies, and which cards it may run', async () => {
  const host = hostSaying(JSON.stringify({ reply: 'ok', intents: [] }))
  await readImagineChat(host, ask('ciao'), inventoryOf({ cards: [CARD] }))
  const instruction = host.prompts[0] ?? ''
  assert.ok(
    instruction.includes('when to use it: Draw a new photo from a sentence.'),
    'the workflow description never reached the reading',
  )
  assert.ok(instruction.includes(CARD.id), 'the card id never reached the reading')
  assert.ok(instruction.includes('Lookbook'), 'the card title never reached the reading')
  assert.ok(instruction.includes('276.title'), 'the card inputs never reached the reading')
})
