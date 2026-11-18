/**
 * The agent lane, with a fake model and a fake queue: which route reads the
 * line, what each tool puts in the request, when the loop stops, and the one
 * rule the whole feature rests on — the prompt is the user's words, unchanged.
 *
 * No model, no GPU, no network. The only real pieces are the loop, the tool
 * checks and the small JSON shapes the page reads.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  probeTools, readAgentChat, type AgentTurnDeps,
} from '../server/vendor/tool-comfy/agent-loop.ts'
import { putJob, type ImagineJob } from '../server/vendor/tool-comfy/job-queue.ts'
import { asksOnlyForMusic, choicesInLine, numbersInLine } from '../server/vendor/tool-comfy/agent-tools.ts'
import type { ImagineHost } from '../server/src/host.ts'
import type {
  AgentChatAsk, AgentModelEvent, AgentModelRequest, AgentToolSchema,
} from '../shared/agent-chat.ts'
import type { ImagineChatEvent } from '../shared/imagine-chat.ts'
import type { JobBody } from '../server/vendor/tool-comfy/job-start.ts'
import { sizeFor } from '../shared/imagine-sizing.ts'

const MODEL = { provider: 'fake', model: 'fake' } as const

/** A real 1x1 PNG: the media tools check that a source is in the gallery. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** A media folder holding that PNG, for the tools that start from a file. */
const mediaDir = await mkdtemp(join(tmpdir(), 'imagine-agent-media-'))
await writeFile(join(mediaDir, 'photo.png'), ONE_PIXEL_PNG)
// The media tools only need the file to exist; the bytes are not probed.
await writeFile(join(mediaDir, 'clip.mp4'), Buffer.alloc(8))

/** One scripted model: a list of event groups, one per call. */
function scriptedModel(scripts: readonly (readonly AgentModelEvent[])[]) {
  const requests: AgentModelRequest[] = []
  let at = 0
  return {
    requests,
    async *chat(options: AgentModelRequest): AsyncIterable<AgentModelEvent> {
      requests.push(options)
      const events = scripts[Math.min(at, scripts.length - 1)] ?? []
      at += 1
      for (const event of events) yield event
    },
  }
}

/** A tool call written in one chunk, as most gateways stream it. */
function toolCall(name: string, args: Record<string, unknown>, id = 'call_1'): readonly AgentModelEvent[] {
  return [
    { type: 'tool-call', index: 0, id, name, arguments: '' },
    { type: 'tool-call', index: 0, arguments: JSON.stringify(args) },
    { type: 'finish', reason: 'tool_calls' },
  ]
}

/** A text answer. */
function text(value: string): readonly AgentModelEvent[] {
  return [{ type: 'text-delta', text: value }, { type: 'finish', reason: 'stop' }]
}

/** One finished job with one file, in the real queue so the wait settles. */
function finishedJob(id: string, prompt: string): ImagineJob {
  const job: ImagineJob = {
    id,
    action: 'generate',
    prompt,
    status: 'done',
    createdAt: Date.now(),
    files: [{ name: `${id}.webp`, kind: 'image' }],
  }
  putJob(id, job)
  return job
}

/** A host that only carries the classic text surface. */
function classicHost(reply: string): ImagineHost {
  return {
    llm: {
      async *stream(): AsyncIterable<{ type: string; text: string }> {
        yield { type: 'text-delta', text: reply }
      },
    },
  } as unknown as ImagineHost
}

/** A turn with a fake model, a fake start and the events it said. */
function turn(
  scripts: readonly (readonly AgentModelEvent[])[],
  options: {
    text?: string
    limits?: { maxSteps: number; maxJobs: number; waitSeconds: number; turnSeconds: number; confirmSeconds: number }
    mode?: 'auto' | 'off' | 'on'
    capabilities?: { toolCalling?: boolean; vision?: boolean }
    ctx?: ImagineHost
    inventory?: import('../server/vendor/tool-comfy/imagine-chat.ts').WorkflowInventory
    cancelled?: string[]
    outputDir?: string
    existingJobs?: readonly ImagineJob[]
    selfURL?: string
    adopted?: string[]
  } = {},
) {
  const model = scriptedModel(scripts)
  const started: JobBody[] = []
  const events: ImagineChatEvent[] = []
  const jobs = new Map<string, ImagineJob>()
  for (const job of options.existingJobs ?? []) jobs.set(job.id, job)
  let serial = 0
  const request: AgentChatAsk = {
    text: options.text ?? 'una tazza rossa su un tavolo di legno',
    history: [],
    staged: [],
    recent: [],
    model: MODEL,
    projectId: 'project-1',
  }
  const deps: AgentTurnDeps = {
    ctx: options.ctx ?? classicHost('{}'),
    request,
    outputDir: options.outputDir ?? '/nonexistent-imagine-agent-test',
    projectId: 'project-1',
    eraseTool: false,
    modelClient: model,
    surface: {
      mode: () => options.mode ?? 'on',
      limits: () => options.limits ?? { maxSteps: 8, maxJobs: 6, waitSeconds: 300, turnSeconds: 900, confirmSeconds: 15 },
      capabilities: async () => options.capabilities ?? { toolCalling: true },
      ...options.selfURL === undefined ? {} : { selfURL: options.selfURL },
    },
    start: async (body) => {
      started.push(body)
      serial += 1
      const job = finishedJob(`job-${String(serial)}`, typeof body.prompt === 'string' ? body.prompt : '')
      jobs.set(job.id, job)
      // What `startFromBody` hands back is the job as it was queued; only the
      // map knows it has finished. The loop has to read the map.
      return [{ ...job, status: 'queued', files: undefined }]
    },
    jobView: job => job,
    listJobs: () => [...jobs.values()],
    getJob: id => jobs.get(id),
    adoptFiles: async (names) => { options.adopted?.push(...names) },
    cancelJob: async (id) => { options.cancelled?.push(id); return true },
    ...options.inventory === undefined ? {} : { inventory: options.inventory },
    say: event => { events.push(event) },
  }
  return { deps, model, started, events }
}

test('the prompt the tool sends is the user\'s words, unchanged', async () => {
  const words = 'una tazza rossa su un tavolo di legno, con la luce del mattino dalla finestra'
  const { deps, started, model } = turn([toolCall('generate_image', { prompt: words, aspect: '3:2' }), text('Fatto.')], { text: words })
  const answer = await readAgentChat(deps)
  assert.equal(answer.mode, 'agent')
  assert.equal(started.length, 1)
  assert.equal(started[0]?.prompt, words, 'not one word added, removed or translated')
  assert.equal(started[0]?.action, 'generate')
  assert.equal(started[0]?.aspectRatio, '3:2')
  assert.equal(started[0]?.size, sizeFor('3:2', '1080p'))
  assert.equal(started[0]?.projectId, 'project-1')
  // The model saw the words exactly once, as the user wrote them.
  const user = model.requests[0]?.messages.find(message => message.role === 'user')
  assert.equal(user?.content, words)
  assert.deepEqual(answer.jobIds, ['job-1'])
  assert.equal(answer.reply, 'Fatto.')
})

test('a tool result is handed back with the run it queued, and the model stops', async () => {
  const { deps, model } = turn([toolCall('generate_image', { prompt: 'un faro al tramonto' }), text('Ecco la foto.')], { text: 'un faro al tramonto' })
  const answer = await readAgentChat(deps)
  assert.equal(model.requests.length, 2)
  const toolMessage = model.requests[1]?.messages.at(-1)
  assert.equal(toolMessage?.role, 'tool')
  assert.equal(toolMessage?.toolCallId, 'call_1')
  const result = JSON.parse(toolMessage?.content ?? '{}') as { state?: string; files?: string[] }
  assert.equal(result.state, 'done')
  assert.deepEqual(result.files, ['job-1.webp'])
  assert.equal(answer.reply, 'Ecco la foto.')
})

test('an argument the studio cannot run is refused, and the model reads why', async () => {
  const { deps, started, model } = turn([
    toolCall('generate_image', { prompt: 'un gatto', aspect: '7:3' }),
    text('Quel formato non esiste.'),
  ])
  const answer = await readAgentChat(deps)
  assert.equal(started.length, 0)
  const refusal = JSON.parse(model.requests[1]?.messages.at(-1)?.content ?? '{}') as { ok?: boolean; error?: string }
  assert.equal(refusal.ok, false)
  assert.match(refusal.error ?? '', /aspect must be one of/)
  assert.equal(answer.reply, 'Quel formato non esiste.')
})

test('the step ceiling is a ceiling: one last call without tools writes the reply', async () => {
  const scripts = [
    toolCall('generate_image', { prompt: 'prima' }, 'call_1'),
    toolCall('generate_image', { prompt: 'seconda' }, 'call_2'),
    text('Ho messo in coda due foto.'),
  ]
  const { deps, model, started } = turn(scripts, { limits: { maxSteps: 2, maxJobs: 6, waitSeconds: 300, turnSeconds: 900, confirmSeconds: 15 } })
  const answer = await readAgentChat(deps)
  assert.equal(started.length, 2)
  assert.equal(model.requests.length, 3)
  const last = model.requests[2]
  assert.equal(last?.tools, undefined, 'the final call cannot call a tool')
  assert.equal(answer.reply, 'Ho messo in coda due foto.')
  assert.deepEqual(answer.jobIds, ['job-1', 'job-2'])
})

test('malformed arguments are a refusal, not a crash', async () => {
  const broken: readonly AgentModelEvent[] = [
    { type: 'tool-call', index: 0, id: 'call_1', name: 'generate_image', arguments: '{"prompt":' },
    { type: 'finish', reason: 'tool_calls' },
  ]
  const { deps, started, model } = turn([broken, text('Riprovo.')])
  const answer = await readAgentChat(deps)
  assert.equal(started.length, 0)
  const refusal = JSON.parse(model.requests[1]?.messages.at(-1)?.content ?? '{}') as { ok?: boolean; error?: string }
  assert.match(refusal.error ?? '', /not valid JSON/)
  assert.equal(answer.reply, 'Riprovo.')
})

test('a model that declares no tools is probed once, and the answer is remembered', async () => {
  const model = scriptedModel([
    toolCall('probe', {}),
    toolCall('generate_image', { prompt: 'un albero' }),
    text('Fatto.'),
  ])
  const route = { provider: 'local', model: 'no-capabilities' }
  assert.equal(await probeTools(model, route), true)
  assert.equal(await probeTools(model, route), true)
  assert.equal(model.requests.length, 1, 'the probe is cached for the life of the process')
  assert.equal(model.requests[0]?.tools?.[0]?.function.name, 'probe')
})

test('the switch off means the classic lane, and says why', async () => {
  const { deps } = turn([text('never')], {
    mode: 'off',
    ctx: classicHost(JSON.stringify({ reply: 'Ciao, dimmi cosa vuoi.', intents: [], read: true })),
  })
  const answer = await readAgentChat(deps)
  assert.equal(answer.mode, 'classic')
  assert.equal(answer.skipped, 'off')
  assert.equal(answer.reply, 'Ciao, dimmi cosa vuoi.')
})

test('a gateway that says the model has no tools keeps the classic lane, without probing', async () => {
  const { deps, model } = turn([text('never')], {
    mode: 'auto',
    capabilities: { toolCalling: false },
    ctx: classicHost(JSON.stringify({ reply: 'Classica.', intents: [], read: true })),
  })
  const answer = await readAgentChat(deps)
  assert.equal(answer.mode, 'classic')
  assert.equal(answer.skipped, 'no-tools')
  assert.equal(model.requests.length, 0)
})

test('the eraser is offered only when the plugin is mounted', async () => {
  const { deps, model } = turn([
    toolCall('erase', { source: 'x.webp', target: 'a logo' }),
    text('Il plugin non c\'è.'),
  ])
  await readAgentChat(deps)
  const schemas = model.requests[0]?.tools as readonly AgentToolSchema[]
  assert.equal(schemas.some(tool => tool.function.name === 'erase'), false)
  const refusal = JSON.parse(model.requests[1]?.messages.at(-1)?.content ?? '{}') as { error?: string }
  assert.match(refusal.error ?? '', /eraser plugin is not mounted/)
})

test('a run past the wait closes the turn, and the jobs keep going', async () => {
  const model = scriptedModel([
    toolCall('generate_image', { prompt: 'un castello' }),
    text('Sta ancora girando: il risultato compare da solo.'),
  ])
  const running: ImagineJob = { id: 'slow-1', action: 'generate', prompt: 'un castello', status: 'running', createdAt: Date.now() }
  putJob(running.id, running)
  const events: ImagineChatEvent[] = []
  const deps: AgentTurnDeps = {
    ctx: classicHost('{}'),
    request: { text: 'un castello', history: [], staged: [], recent: [], model: MODEL, projectId: 'project-1' },
    outputDir: '/nonexistent-imagine-agent-test',
    projectId: 'project-1',
    eraseTool: false,
    modelClient: model,
    surface: {
      mode: () => 'on',
      limits: () => ({ maxSteps: 8, maxJobs: 6, waitSeconds: 0, turnSeconds: 900, confirmSeconds: 15 }),
      capabilities: async () => ({ toolCalling: true }),
    },
    start: async () => [running],
    jobView: job => job,
    listJobs: () => [running],
    getJob: id => id === running.id ? running : undefined,
    adoptFiles: async () => undefined,
    cancelJob: async () => true,
    say: event => { events.push(event) },
  }
  const answer = await readAgentChat(deps)
  // One tool call, then one final call with no tools: no polling loop.
  assert.equal(model.requests.length, 2)
  assert.equal(model.requests[1]?.tools, undefined)
  assert.equal(answer.running, true)
  assert.deepEqual(answer.jobIds, ['slow-1'])
  assert.match(answer.reply, /girando/)
})

test('a ratio and a resolution the user named are recovered from their line', () => {
  assert.deepEqual(choicesInLine('una tazza, quadrata, a 480p'), { aspect: '1:1', resolution: '480p' })
  assert.deepEqual(choicesInLine('un faro in formato 3:2'), { aspect: '3:2' })
  assert.deepEqual(choicesInLine('un ritratto verticale a 720p'), { aspect: '9:16', resolution: '720p' })
  assert.deepEqual(choicesInLine('una tazza rossa'), {})
  // A ratio that is not on the studio's ladder is not one.
  assert.deepEqual(choicesInLine('un poster 7:3'), {})
})

test('a clip tool sends the length and the ladder the user named', async () => {
  const { deps, started } = turn([
    toolCall('make_video', { source: 'photo.png', prompt: 'la camera si avvicina', seconds: 10, aspect: '9:16', resolution: '480p', speed: 'slow' }),
    text('Fatto.'),
  ], { text: 'un video di 10 secondi, verticale, a 480p', outputDir: mediaDir })
  const answer = await readAgentChat(deps)
  assert.equal(answer.mode, 'agent')
  assert.equal(started.length, 1)
  assert.equal(started[0]?.action, 'video')
  assert.equal(started[0]?.seconds, 10)
  assert.equal(started[0]?.aspectRatio, '9:16 (Portrait Widescreen)')
  assert.equal(started[0]?.megapixels, 0.4)
  assert.equal(started[0]?.speed, 'slow')
  assert.equal(started[0]?.quality, 'high')
  assert.equal(answer.pending, undefined)
})

test('a clip past the confirmation limit stops, and only a yes queues it', async () => {
  const { deps, started, events } = turn([
    toolCall('make_video', { source: 'photo.png', prompt: 'la camera si allontana', seconds: 20 }),
    text('Fatto: venti secondi.'),
  ], { text: 'un video di 20 secondi', outputDir: mediaDir })
  const first = await readAgentChat(deps)
  assert.equal(first.pending?.kind, 'run')
  assert.equal(first.pending?.tool, 'make_video')
  assert.equal(first.pending?.seconds, 20)
  assert.match(first.pending?.summary ?? '', /20/)
  assert.equal(started.length, 0, 'nothing is queued before the yes')
  assert.equal(events.some(event => event.kind === 'step' && event.step === 'confirm'), true)
  const second = await readAgentChat({ ...deps, request: { ...deps.request, confirmation: { token: first.pending?.token ?? '', accept: true } } })
  assert.equal(started.length, 1)
  assert.equal(second.pending, undefined)
  assert.deepEqual(second.jobIds, ['job-1'])
  assert.equal(second.reply, 'Fatto: venti secondi.')
})

test('a no tells the model and runs nothing', async () => {
  const { deps, started, model } = turn([
    toolCall('make_video', { source: 'photo.png', prompt: 'gira', seconds: 30 }),
    text('Va bene, non lo faccio.'),
  ], { outputDir: mediaDir })
  const first = await readAgentChat(deps)
  const second = await readAgentChat({ ...deps, request: { ...deps.request, confirmation: { token: first.pending?.token ?? '', accept: false } } })
  assert.equal(started.length, 0)
  const toolMessage = model.requests[1]?.messages.at(-1)
  assert.equal(toolMessage?.role, 'tool')
  assert.match(toolMessage?.content ?? '', /declined/)
  assert.equal(second.reply, 'Va bene, non lo faccio.')
})

test('a story, a song, a card and a 4K upscale always ask first', async () => {
  const inventory = {
    list: [],
    cards: [{ id: 'card-1', title: 'Ritratto pulito', description: '', inputs: [] }],
    summarise: () => undefined,
    fields: () => undefined,
    facts: async () => undefined,
    warnings: () => undefined,
    overridden: () => false,
    plan: () => undefined,
  } as unknown as import('../server/vendor/tool-comfy/imagine-chat.ts').WorkflowInventory
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ['make_story', { prompt: 'un viaggio', source: 'photo.png', seconds: 20 }],
    ['make_music', { prompt: 'jazz lento', seconds: 40 }],
    ['run_card', { customWorkflowId: 'card-1' }],
    ['upscale', { source: 'photo.png', upscaleTo: 2160 }],
  ]
  for (const [name, args] of cases) {
    const { deps, started } = turn([toolCall(name, args), text('ok')], { inventory, outputDir: mediaDir })
    const answer = await readAgentChat(deps)
    assert.equal(answer.pending?.tool, name, `${name} asks first`)
    assert.equal(started.length, 0)
  }
  // A step that is not 4K does not ask.
  const plain = turn([toolCall('upscale', { source: 'photo.png', upscaleTo: 1440 }), text('ok')], { outputDir: mediaDir })
  const answer = await readAgentChat(plain.deps)
  assert.equal(answer.pending, undefined)
  assert.equal(plain.started.length, 1)
})

test('a cancel is only ever a proposal, and the yes really stops the run', async () => {
  const cancelled: string[] = []
  const { deps } = turn([
    toolCall('cancel_job', { job: 'live-1' }),
    text('L\'ho fermato.'),
  ], { cancelled, existingJobs: [{ id: 'live-1', action: 'video', prompt: 'un clip', status: 'running', createdAt: Date.now() }] })
  const first = await readAgentChat(deps)
  assert.equal(first.pending?.kind, 'cancel')
  assert.equal(cancelled.length, 0, 'the proposal never stops anything by itself')
  const second = await readAgentChat({ ...deps, request: { ...deps.request, confirmation: { token: first.pending?.token ?? '', accept: true } } })
  assert.deepEqual(cancelled, ['live-1'])
  assert.equal(second.reply, 'L\'ho fermato.')

})

test('a declined cancel says what the run is doing now', async () => {
  const { deps, model } = turn([
    toolCall('cancel_job', { job: 'live-2' }),
    text('Va bene, lo lascio andare.'),
  ], { existingJobs: [{ id: 'live-2', action: 'video', prompt: 'un clip', status: 'running', createdAt: Date.now() }] })
  const first = await readAgentChat(deps)
  assert.equal(first.pending?.kind, 'cancel')
  await readAgentChat({ ...deps, request: { ...deps.request, confirmation: { token: first.pending?.token ?? '', accept: false } } })
  const message = model.requests[1]?.messages.at(-1)
  assert.match(message?.content ?? '', /"state":"running"/)
})

test('a count and a length the user named are recovered from their line', () => {
  assert.deepEqual(numbersInLine('fai tre foto di un faro'), { count: 3 })
  assert.deepEqual(numbersInLine('un video di 16 secondi'), { seconds: 16 })
  assert.deepEqual(numbersInLine('un clip da 30s'), { seconds: 30 })
  assert.deepEqual(numbersInLine('due minuti di video'), { seconds: 120 })
  assert.deepEqual(numbersInLine('un video in 16:9'), {})
})

test('the count and the length the model drops still reach the run', async () => {
  const photos = turn([toolCall('generate_image', { prompt: 'un faro' }), text('Tre foto.')], { text: 'fai tre foto di un faro' })
  await readAgentChat(photos.deps)
  assert.equal(photos.started[0]?.count, 3)
  const clip = turn([toolCall('make_video', { source: 'photo.png', prompt: 'gira' }), text('Sedici secondi.')], { text: 'un video di 16 secondi', outputDir: mediaDir })
  const answer = await readAgentChat(clip.deps)
  // The length is over the limit: the recovery also drives the confirmation.
  assert.equal(answer.pending?.seconds, 16)
})

test('a personal card runs with its own exposed inputs, and nothing else', async () => {
  const inventory = {
    list: [],
    cards: [{
      id: 'card-1', title: 'Ritratto pulito', description: '',
      inputs: [
        { node: '10', field: 'text', label: 'Testo', kind: 'text' },
        { node: '10', field: 'steps', label: 'Passi', kind: 'number' },
      ],
    }],
    summarise: () => undefined,
    fields: () => undefined,
    facts: async () => undefined,
    warnings: () => undefined,
    overridden: () => false,
    plan: () => undefined,
  } as unknown as import('../server/vendor/tool-comfy/imagine-chat.ts').WorkflowInventory
  const { deps, started } = turn([
    toolCall('run_card', { customWorkflowId: 'card-1', prompt: 'un ritratto', customFields: { '10.text': 'ciao', '10.steps': 8, '99.invented': 'x' } }),
    text('Fatto.'),
  ], { inventory, outputDir: mediaDir })
  const first = await readAgentChat(deps)
  assert.equal(first.pending?.card, 'Ritratto pulito')
  await readAgentChat({ ...deps, request: { ...deps.request, confirmation: { token: first.pending?.token ?? '', accept: true } } })
  assert.equal(started[0]?.action, 'custom')
  assert.equal(started[0]?.customWorkflowId, 'card-1')
  assert.deepEqual(started[0]?.customFields, { '10.text': 'ciao', '10.steps': 8 })
})

test('a track is laid over a clip on the host, with no run and no question', async () => {
  await writeFile(join(mediaDir, 'track.mp3'), Buffer.alloc(8))
  const realFetch = globalThis.fetch
  let asked: { url: string; body: unknown } | undefined
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked = { url: String(input), body: JSON.parse(String(init?.body)) }
    return new Response(JSON.stringify({ name: 'joined.mp4', kind: 'video', size: 3, mtime: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const made: string[] = []
    const { deps } = turn([
      toolCall('add_audio', { video: 'clip.mp4', track: 'track.mp3' }),
      text('Fatto.'),
    ], { outputDir: mediaDir, selfURL: 'http://studio.test', adopted: made })
    const answer = await readAgentChat(deps)
    assert.equal(answer.pending, undefined, 'a host edit does not ask')
    assert.deepEqual(made, ['joined.mp4'])
    assert.deepEqual(asked, { url: 'http://studio.test/api/add-audio', body: { name: 'clip.mp4', track: 'track.mp3' } })
  } finally {
    globalThis.fetch = realFetch
  }
})

test('run_action reaches object swap, relight and recreate with the studio fields', async () => {
  const swap = turn([
    toolCall('run_action', {
      action: 'objectSwap', prompt: 'la bottiglia diventa blu', source: 'clip.mp4', reference: 'photo.png',
      extras: { objectMode: 'change', swapResolution: '480p' },
    }),
    text('Fatto.'),
  ], { outputDir: mediaDir })
  await readAgentChat(swap.deps)
  assert.equal(swap.started[0]?.action, 'objectSwap')
  assert.equal(swap.started[0]?.objectMode, 'change')
  assert.equal(swap.started[0]?.source, 'clip.mp4')
  assert.equal(swap.started[0]?.reference, 'photo.png')
  assert.equal(swap.started[0]?.swapResolution, '480p')

  const { RELIGHT_LOOKS } = await import('../shared/relight-looks.ts')
  const light = turn([
    toolCall('run_action', { action: 'relight', prompt: '', source: 'photo.png', extras: { light: RELIGHT_LOOKS[0]?.id ?? 'cold_beam' } }),
    text('Fatto.'),
  ], { outputDir: mediaDir })
  await readAgentChat(light.deps)
  assert.equal(light.started[0]?.action, 'relight')
  assert.equal(light.started[0]?.light, RELIGHT_LOOKS[0]?.id)

  const reshot = turn([
    toolCall('run_action', { action: 'recreate', prompt: 'più vicino', source: 'clip.mp4', extras: { keepAudio: true } }),
    text('Fatto.'),
  ], { outputDir: mediaDir })
  await readAgentChat(reshot.deps)
  assert.equal(reshot.started[0]?.action, 'recreate')
  assert.equal(reshot.started[0]?.keepAudio, true)
})

test('run_action refuses an unknown action, a field it does not know and a missing file', async () => {
  const unknown = turn([toolCall('run_action', { action: 'makeCoffee' }), text('No.')])
  await readAgentChat(unknown.deps)
  assert.equal(unknown.started.length, 0)
  const refused = JSON.parse(unknown.model.requests[1]?.messages.at(-1)?.content ?? '{}') as { error?: string }
  assert.match(refused.error ?? '', /action must be one of/)

  const extra = turn([toolCall('run_action', { action: 'bg', source: 'photo.png', extras: { projectId: 'x' } }), text('No.')], { outputDir: mediaDir })
  await readAgentChat(extra.deps)
  assert.equal(extra.started.length, 0)
  const wrong = JSON.parse(extra.model.requests[1]?.messages.at(-1)?.content ?? '{}') as { error?: string }
  assert.match(wrong.error ?? '', /not a field of a studio request/)

  const missing = turn([toolCall('run_action', { action: 'video', prompt: 'gira' }), text('No.')], { outputDir: mediaDir })
  await readAgentChat(missing.deps)
  assert.equal(missing.started.length, 0)
  const needed = JSON.parse(missing.model.requests[1]?.messages.at(-1)?.content ?? '{}') as { error?: string }
  assert.match(needed.error ?? '', /starts from a file/)
})

test('run_action goes through the confirmation gate too', async () => {
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ['story', { prompt: 'un viaggio', source: 'photo.png', extras: { seconds: 30 } }],
    ['music', { prompt: 'jazz', extras: {} }],
    ['video', { prompt: 'gira', source: 'photo.png', extras: { seconds: 20 } }],
    ['upscale', { source: 'photo.png', extras: { upscaleTo: 2160 } }],
  ]
  for (const [action, fields] of cases) {
    const { deps, started } = turn([toolCall('run_action', { action, ...fields }), text('ok')], { outputDir: mediaDir })
    const answer = await readAgentChat(deps)
    assert.equal(answer.pending?.tool, 'run_action', `${action} asks first`)
    assert.equal(started.length, 0)
  }
  // Under the limit, a video does not ask.
  const plain = turn([toolCall('run_action', { action: 'video', prompt: 'gira', source: 'photo.png', extras: { seconds: 10 } }), text('ok')], { outputDir: mediaDir })
  assert.equal((await readAgentChat(plain.deps)).pending, undefined)
  assert.equal(plain.started.length, 1)
})

test('a line that asks only for a track is refused by make_story, and pointed at make_music', async () => {
  const { deps, started, model } = turn([
    toolCall('make_story', { prompt: 'musica rilassante', seconds: 30 }),
    text('Uso make_music.'),
  ], { text: 'Fai 30 secondi di musica rilassante' })
  const answer = await readAgentChat(deps)
  assert.equal(answer.pending, undefined, 'a track is not a story to confirm')
  assert.equal(started.length, 0)
  const refusal = JSON.parse(model.requests[1]?.messages.at(-1)?.content ?? '{}') as { ok?: boolean; error?: string }
  assert.equal(refusal.ok, false)
  assert.match(refusal.error ?? '', /make_music/)
})

test('a line that names a video with its song still belongs to make_story', async () => {
  const { deps } = turn([
    toolCall('make_story', { prompt: 'un viaggio', source: 'photo.png', song: 'track.mp3', seconds: 30 }),
    text('ok'),
  ], { text: 'un video di 30 secondi con questa canzone', outputDir: mediaDir })
  await writeFile(join(mediaDir, 'track.mp3'), Buffer.alloc(8))
  const answer = await readAgentChat(deps)
  assert.equal(answer.pending?.tool, 'make_story')
})

test('music words are read from the line, and a picture word makes it a story', () => {
  assert.equal(asksOnlyForMusic('Fai 30 secondi di musica rilassante'), true)
  assert.equal(asksOnlyForMusic('Crea una canzone triste'), true)
  assert.equal(asksOnlyForMusic('Solo musica, nessun video'), true)
  assert.equal(asksOnlyForMusic('Make a 30 second track'), true)
  assert.equal(asksOnlyForMusic('un video di 30 secondi con questa canzone'), false)
  assert.equal(asksOnlyForMusic('un montaggio sulle note di questa canzone'), false)
  assert.equal(asksOnlyForMusic('una storia di 20 secondi'), false)
})

test('a run waiting for an install is reported as such, never as running', async () => {
  const stalled: ImagineJob = {
    id: 'stall-1',
    action: 'upscale',
    prompt: '',
    status: 'queued',
    createdAt: Date.now(),
    notice: 'setup-needed',
    setup: { packs: [], models: [{ name: 'seedvr2_7b_sharp_nvfp4.safetensors', folder: 'upscale', size: 4_760_000_000 }], bytes: 4_760_000_000 },
  }
  putJob(stalled.id, stalled)
  const model = scriptedModel([
    toolCall('upscale', { source: 'photo.png', upscaleTo: 1440 }),
    text('Non doveva arrivare qui.'),
  ])
  const events: ImagineChatEvent[] = []
  const deps: AgentTurnDeps = {
    ctx: classicHost('{}'),
    request: { text: 'ingrandisci la foto', history: [], staged: [], recent: [], model: MODEL, projectId: 'project-1' },
    outputDir: mediaDir,
    projectId: 'project-1',
    eraseTool: false,
    modelClient: model,
    surface: {
      mode: () => 'on',
      limits: () => ({ maxSteps: 8, maxJobs: 6, waitSeconds: 300, turnSeconds: 900, confirmSeconds: 15 }),
      capabilities: async () => ({ toolCalling: true }),
    },
    start: async () => [stalled],
    jobView: job => job,
    listJobs: () => [stalled],
    getJob: id => id === stalled.id ? stalled : undefined,
    adoptFiles: async () => undefined,
    cancelJob: async () => true,
    say: event => { events.push(event) },
  }
  const answer = await readAgentChat(deps)
  assert.match(answer.reply, /seedvr2_7b_sharp_nvfp4\.safetensors/)
  assert.match(answer.reply, /Installa/)
  assert.doesNotMatch(answer.reply, /in corso|ancora girando/)
  assert.equal(answer.running, undefined)
  assert.deepEqual(answer.jobIds, ['stall-1'])
  // The fixed reply ends the turn: the model never got a second call in which
  // to call the waiting run "in corso".
  assert.equal(model.requests.length, 1)
})

test('job_status says a run waits for an install, and names what is missing', async () => {
  const stalled: ImagineJob = {
    id: 'stall-2',
    action: 'upscale',
    prompt: '',
    status: 'queued',
    createdAt: Date.now(),
    notice: 'setup-needed',
    setup: { packs: [], models: [{ name: 'seedvr2_7b_sharp_nvfp4.safetensors', folder: 'upscale', size: 4_760_000_000 }], bytes: 4_760_000_000 },
  }
  putJob(stalled.id, stalled)
  const { deps, model } = turn([toolCall('job_status', { job: 'stall-2' }), text('ok')], { existingJobs: [stalled] })
  await readAgentChat(deps)
  const result = JSON.parse(model.requests[1]?.messages.at(-1)?.content ?? '{}') as {
    job?: { state?: string; missing?: string[]; waitingFor?: string }
  }
  assert.equal(result.job?.state, 'setup-needed')
  assert.deepEqual(result.job?.missing, ['seedvr2_7b_sharp_nvfp4.safetensors (4.8 GB)'])
  assert.match(result.job?.waitingFor ?? '', /not rendering/)
})

test('a model that writes nothing still leaves something to read', async () => {
  const { deps } = turn([[], []])
  const answer = await readAgentChat(deps)
  assert.ok(answer.reply.trim().length > 0)
})
