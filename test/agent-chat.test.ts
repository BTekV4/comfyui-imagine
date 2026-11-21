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
  jobBudgetFor, probeTools, readAgentChat, type AgentTurnDeps,
} from '../server/vendor/tool-comfy/agent-loop.ts'
import { putJob, type ImagineJob } from '../server/vendor/tool-comfy/job-queue.ts'
import { asksOnlyForMusic, choicesInLine, numbersInLine, runAgentTool } from '../server/vendor/tool-comfy/agent-tools.ts'
import { languageOfPrompt, languageOfReply, replyNeedsRewrite, rewriteAsk } from '../server/vendor/tool-comfy/reply-language.ts'
import type { ImagineHost } from '../server/src/host.ts'
import type {
  AgentChatAsk, AgentModelEvent, AgentModelRequest, AgentToolSchema,
} from '../shared/agent-chat.ts'
import type { ImagineChatEvent } from '../shared/imagine-chat.ts'
import type { JobBody } from '../server/vendor/tool-comfy/job-start.ts'
import { sizeFor } from '../shared/imagine-sizing.ts'
import { AGENT_JOBS_CEILING, answerStartedWork } from '../shared/agent-chat.ts'
import { MAX_JOB_COUNT } from '../server/vendor/tool-comfy/job-request.ts'

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

/** A host whose vision pass answers with the next scripted JSON. */
function seeingHost(answers: readonly string[]): ImagineHost {
  let at = 0
  return {
    auxiliary: {
      async analyzeImage(): Promise<{ text: string; provider: string; model: string }> {
        const text = answers[Math.min(at, answers.length - 1)] ?? '{}'
        at += 1
        return { text, provider: 'fake', model: 'fake' }
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
    language?: string
    history?: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[]
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
    history: [...(options.history ?? [])],
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
    ...options.language === undefined ? {} : { language: options.language },
    modelClient: model,
    surface: {
      mode: () => options.mode ?? 'on',
      limits: () => options.limits ?? { maxSteps: 8, maxJobs: 6, waitSeconds: 300, turnSeconds: 900, confirmSeconds: 15 },
      capabilities: async () => options.capabilities ?? { toolCalling: true },
      ...options.selfURL === undefined ? {} : { selfURL: options.selfURL },
    },
    start: async (body) => {
      started.push(body)
      // A batch is one job per picture, as `startFromBody` makes it: a count of
      // ten is ten runs, not one run that drew ten. The jobs come back as they
      // were queued; only the map knows they finished, and the loop reads it.
      const batch = typeof body.count === 'number' && body.count > 1 ? body.count : 1
      const made: ImagineJob[] = []
      for (let index = 0; index < batch; index++) {
        serial += 1
        const job = finishedJob(`job-${String(serial)}`, typeof body.prompt === 'string' ? body.prompt : '')
        jobs.set(job.id, job)
        made.push(job)
      }
      return made.map(job => ({ ...job, status: 'queued' as const, files: undefined }))
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
  const result = JSON.parse(toolMessage?.content ?? '{}') as { state?: string; files?: { name: string }[] }
  assert.equal(result.state, 'done')
  // No such file in this test's folder, so no measures: only the name.
  assert.deepEqual(result.files, [{ name: 'job-1.webp' }])
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

test('an edit can change the frame shape the user named, and a wrong shape is reported back', async () => {
  // The run "makes" a 1x1 picture: the model must read that it is not 9:16.
  const dir = await mkdtemp(join(tmpdir(), 'imagine-agent-shape-'))
  await writeFile(join(dir, 'photo.png'), ONE_PIXEL_PNG)
  await writeFile(join(dir, 'job-1.webp'), ONE_PIXEL_PNG)
  const { deps, started, model } = turn([
    toolCall('edit_image', { source: 'photo.png', prompt: 'una luce più calda', target: 'the sky' }),
    text('Il formato non è 9:16.'),
  ], { text: 'modifica questa foto con una luce più calda e falla in 9:16', outputDir: dir })
  await readAgentChat(deps)
  assert.equal(started.length, 1)
  assert.equal(started[0]?.action, 'remix')
  assert.equal(started[0]?.aspectRatio, '9:16')
  assert.equal(started[0]?.canvasAsked, true)
  assert.deepEqual(started[0]?.size, sizeFor('9:16', '1080p'))
  // A new shape redraws the whole frame: the zone is dropped.
  assert.equal(started[0]?.region, undefined)
  const result = JSON.parse(model.requests[1]?.messages.at(-1)?.content ?? '{}') as {
    files?: { name: string; width?: number; height?: number; ratio?: string }[]
    mismatch?: string
    aspect?: string
  }
  assert.equal(result.aspect, '9:16')
  assert.deepEqual(result.files, [{ name: 'job-1.webp', width: 1, height: 1, ratio: '1:1' }])
  assert.match(result.mismatch ?? '', /asked 9:16, made job-1\.webp 1:1/)
})

test('the instruction keeps the studio orders out of the drawn prompt', async () => {
  const { agentInstruction } = await import('../server/vendor/tool-comfy/agent-prompt.ts')
  const text = await agentInstruction({
    request: { text: 'x', history: [], staged: [], recent: [], model: MODEL },
    known: [],
    eraseTool: false,
    working: [],
    maxSteps: 8,
    maxJobs: 6,
  })
  assert.match(text, /draws every word it gets/)
  assert.match(text, /`edit_image` with `aspect`/)
  assert.match(text, /mismatch/)
})


test('every tool result carries the language the reply is written in', async () => {
  const { deps, model } = turn([toolCall('generate_image', { prompt: 'una tazza bianca' }), text('Ecco la foto.')], {
    text: 'una tazza bianca',
    language: 'it',
  })
  await readAgentChat(deps)
  const result = JSON.parse(model.requests[1]?.messages.at(-1)?.content ?? '{}') as { reply_language?: string }
  assert.equal(result.reply_language, 'it')
})

test('a reply written in English is asked for once more, in Italian', async () => {
  const { deps, model } = turn([
    toolCall('generate_image', { prompt: 'una tazza bianca' }),
    text('Here is the photo you asked for, with the cup on the table and a warm light.'),
    text('Ecco la foto che hai chiesto, con la tazza sul tavolo e una luce calda.'),
  ], { text: 'una tazza bianca', language: 'it' })
  const answer = await readAgentChat(deps)
  assert.equal(answer.reply, 'Ecco la foto che hai chiesto, con la tazza sul tavolo e una luce calda.')
  assert.equal(model.requests.length, 3)
  const rewrite = model.requests[2]?.messages.at(-1)?.content ?? ''
  assert.match(rewrite, /Rewrite your last reply in Italiano/)
  // No tools on the rewrite: it is a sentence, not another turn.
  assert.equal(model.requests[2]?.tools, undefined)
})

test('an Italian reply is not rewritten, and an unplaceable one is left alone', () => {
  assert.equal(languageOfReply('Ecco la foto, la tazza è sul tavolo con una luce calda.'), 'it')
  assert.equal(languageOfReply('Here is the photo, the cup is on the table with warm light.'), 'en')
  assert.equal(replyNeedsRewrite('Ecco la foto, la tazza è sul tavolo con una luce calda.', 'it'), false)
  assert.equal(replyNeedsRewrite('Here is the photo, the cup is on the table with warm light.', 'it'), true)
  assert.equal(replyNeedsRewrite('Fatto.', 'it'), false)
  // A stray foreign script is caught even when the rest of the sentence is Italian.
  assert.equal(replyNeedsRewrite('La scena è现在 più scura, con ombre profonde.', 'it'), true)
  assert.match(rewriteAsk('it'), /Italiano/)
})


test('a translated edit prompt is replaced by the user\'s own line', async () => {
  const started: JobBody[] = []
  const outcome = await runAgentTool('edit_image', {
    source: 'photo.png',
    prompt: 'Make the light darker.',
  }, {
    ctx: classicHost('{}'),
    outputDir: mediaDir,
    language: 'it',
    asked: 'come prima ma più scuro',
    eraseTool: false,
    known: [],
    canQueue: () => 1,
    say: () => undefined,
    start: async (body) => { started.push(body); return [] },
    jobView: job => job,
    listJobs: () => [],
    getJob: () => undefined,
    adoptFiles: async () => undefined,
    cancelJob: async () => true,
  })
  assert.equal(outcome.result['ok'], true)
  assert.equal(started[0]?.prompt, 'come prima ma più scuro')
})

test('a prompt in the user\'s own language is left alone', async () => {
  assert.equal(languageOfPrompt('rendi la luce più scura'), 'it')
  assert.equal(languageOfPrompt('Make the light darker.'), 'en')
})

test('a look answers one targeted question and carries the real measures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagine-agent-look-'))
  await writeFile(join(dir, 'photo.png'), ONE_PIXEL_PNG)
  const asked: string[] = []
  const host = {
    auxiliary: {
      async analyzeImage(_path: string, instruction: string) {
        asked.push(instruction)
        return { text: 'La tazza è bianca e il tavolo è di legno.' }
      },
    },
  } as unknown as ImagineHost
  const outcome = await runAgentTool('look', { file: 'photo.png', question: 'la tazza è blu?' }, {
    ctx: host,
    outputDir: dir,
    model: MODEL,
    language: 'it',
    asked: 'la tazza è blu?',
    eraseTool: false,
    known: [],
    canQueue: () => 1,
    say: () => undefined,
    start: async () => [],
    jobView: job => job,
    listJobs: () => [],
    getJob: () => undefined,
    adoptFiles: async () => undefined,
    cancelJob: async () => true,
  })
  assert.equal(outcome.result['ok'], true)
  assert.equal(outcome.result['width'], 1)
  assert.equal(outcome.result['height'], 1)
  assert.equal(outcome.result['ratio'], '1:1')
  assert.equal(outcome.result['seen'], 'La tazza è bianca e il tavolo è di legno.')
  assert.equal(asked.length, 1)
  assert.match(asked[0] ?? '', /Answer only this question/)
  assert.match(asked[0] ?? '', /la tazza è blu\?/)
  assert.doesNotMatch(asked[0] ?? '', /Describe what is visible/)
  // The header's numbers are in the instruction, and estimating is forbidden.
  assert.match(asked[0] ?? '', /1x1 pixels/)
  assert.match(asked[0] ?? '', /ratio 1:1/)
  assert.match(asked[0] ?? '', /Do not estimate dimensions/)
})

test('the instruction makes the measures win and asks before guessing a change', async () => {
  const { agentInstruction } = await import('../server/vendor/tool-comfy/agent-prompt.ts')
  const text = await agentInstruction({
    request: { text: 'x', history: [], staged: [], recent: [], model: MODEL },
    known: [],
    eraseTool: false,
    working: [],
    maxSteps: 8,
    maxJobs: 6,
  })
  assert.match(text, /are measured from the file/)
  assert.match(text, /not an instruction until the user says/)
})


test('a resolution without a shape is not dropped: it keeps the studio shape', async () => {
  const { deps, started } = turn([
    toolCall('generate_image', { prompt: 'un vaso di fiori', resolution: '720p' }),
    text('Fatto.'),
  ], { text: 'genera un vaso di fiori a 720p' })
  await readAgentChat(deps)
  assert.equal(started.length, 1)
  assert.equal(started[0]?.size, sizeFor('9:16', '720p'))
  assert.equal(started[0]?.aspectRatio, undefined, 'no shape the user did not ask for')
})


test('a translated run_action prompt is replaced by the user\'s line too', async () => {
  const started: JobBody[] = []
  const outcome = await runAgentTool('run_action', {
    action: 'relight',
    source: 'photo.png',
    prompt: 'Make the light darker, keep the subject and the framing',
    extras: { light: 'evening_lamp' },
  }, {
    ctx: classicHost('{}'),
    outputDir: mediaDir,
    language: 'it',
    asked: 'come prima ma più scuro',
    eraseTool: false,
    known: [],
    canQueue: () => 1,
    say: () => undefined,
    start: async (body) => { started.push(body); return [] },
    jobView: job => job,
    listJobs: () => [],
    getJob: () => undefined,
    adoptFiles: async () => undefined,
    cancelJob: async () => true,
  })
  assert.equal(outcome.result['ok'], true)
  assert.equal(started[0]?.prompt, 'come prima ma più scuro')
})


test('a line that asks for ten pictures gets a budget of ten, not the setting', async () => {
  const limits = { maxSteps: 8, maxJobs: 6, waitSeconds: 300, turnSeconds: 900, confirmSeconds: 15 }
  assert.equal(jobBudgetFor(limits, 'genera una foto di un faro'), 6)
  assert.equal(jobBudgetFor(limits, 'genera 10 foto di un faro, 9:16, 1080p'), 10)
  assert.equal(jobBudgetFor(limits, 'genera 30 immagini'), AGENT_JOBS_CEILING)
  // The tool and the route agree on the batch ceiling: eight was one too few.
  assert.equal(MAX_JOB_COUNT, 10)
})

test('ten pictures are all queued in one turn, and the result says ten', async () => {
  const { deps, started, model } = turn([
    toolCall('generate_image', { prompt: 'un faro al tramonto', aspect: '9:16', resolution: '1080p', count: 10 }),
    text('Dieci foto in coda.'),
  ], { text: 'genera 10 foto di un faro al tramonto, 9:16, 1080p' })
  const answer = await readAgentChat(deps)
  assert.equal(started.length, 1)
  assert.equal(started[0]?.count, 10)
  assert.equal(answer.pending, undefined)
  assert.equal(answer.jobIds.length, 10)
  const result = JSON.parse(model.requests[1]?.messages.at(-1)?.content ?? '{}') as { count?: number; files?: unknown[] }
  assert.equal(result.count, 10)
  assert.equal(result.files?.length, 10)
})

test('twelve pictures go in two calls, and the budget follows the number', async () => {
  const { deps, started } = turn([
    toolCall('generate_image', { prompt: 'un faro', count: 10 }, 'call_1'),
    toolCall('generate_image', { prompt: 'un faro', count: 2 }, 'call_2'),
    text('Dodici foto in coda.'),
  ], { text: 'genera 12 foto di un faro' })
  const answer = await readAgentChat(deps)
  assert.equal(started.length, 2)
  assert.equal(answer.jobIds.length, 12)
})

test('a batch over the budget says how many fit, and never that everything is queued when nothing is', async () => {
  const { deps, started, model } = turn([
    toolCall('generate_image', { prompt: 'un faro', count: 10 }),
    text('Ne posso fare sei.'),
  ], { text: 'genera delle foto di un faro' })
  const answer = await readAgentChat(deps)
  assert.equal(started.length, 0, 'nothing was queued')
  const result = JSON.parse(model.requests[1]?.messages.at(-1)?.content ?? '{}') as { ok?: boolean; error?: string }
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /can still queue 6 runs, not 10/)
  assert.doesNotMatch(result.error ?? '', /already queued all/)
  assert.equal(answer.jobIds.length, 0)
})

test('a retry repeats the previous request number, not a part of it', async () => {
  const limits = { maxSteps: 8, maxJobs: 6, waitSeconds: 300, turnSeconds: 900, confirmSeconds: 15 }
  assert.equal(jobBudgetFor(limits, 'riprova', 'genera 10 foto di un faro'), 10)
  assert.equal(jobBudgetFor(limits, 'riprova'), 6)
  // The model asks a part of it: the request it repeats still says ten.
  const { deps, started } = turn([
    toolCall('generate_image', { prompt: 'un faro', count: 8 }),
    text('Dieci foto in coda.'),
  ], {
    text: 'riprova',
    history: [
      { role: 'user', text: 'genera 10 foto di un faro in stile fumetto' },
      { role: 'assistant', text: 'Nessuna generazione è partita.' },
    ],
  })
  const answer = await readAgentChat(deps)
  assert.equal(started.length, 1)
  assert.equal(started[0]?.count, 10)
  assert.equal(answer.jobIds.length, 10)
})

test('the reply that queued work is never followed by "no work started"', () => {
  const empty = { intents: [], jobIds: [], files: [] }
  assert.equal(answerStartedWork(empty), false)
  assert.equal(answerStartedWork({ ...empty, jobIds: ['job-1'] }), true)
  assert.equal(answerStartedWork({ ...empty, intents: [{}] }), true)
  assert.equal(answerStartedWork({ ...empty, files: [{ name: 'erase.png', kind: 'image' }] }), true)
  assert.equal(answerStartedWork({ ...empty, pending: { token: 't' } }), true)
})

test('a new picture carries one style reference to the run', async () => {
  const { deps, started } = turn([
    toolCall('generate_image', { prompt: 'un faro in stile poster illustrato', aspect: '9:16', reference: 'photo.png' }),
    text('Fatto.'),
  ], { text: 'genera un faro nello stile di questa illustrazione, 9:16', outputDir: mediaDir })
  await readAgentChat(deps)
  assert.equal(started.length, 1)
  assert.equal(started[0]?.reference, 'photo.png')
})

test('a reference name that is not in the gallery is refused', async () => {
  const { deps, model } = turn([
    toolCall('generate_image', { prompt: 'un faro', reference: 'missing.png' }),
    text('Quella foto non c\'è.'),
  ], { text: 'genera un faro nello stile di questa foto', outputDir: mediaDir })
  await readAgentChat(deps)
  const result = JSON.parse(model.requests[1]?.messages.at(-1)?.content ?? '{}') as { ok?: boolean; error?: string }
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /not in the gallery/)
})

test('the instruction takes the style from the pictures and never invents photorealism from the word foto', async () => {
  const { agentInstruction } = await import('../server/vendor/tool-comfy/agent-prompt.ts')
  const text = await agentInstruction({
    request: { text: 'x', history: [], staged: [], recent: [], model: MODEL },
    known: [],
    eraseTool: false,
    working: [],
    maxSteps: 8,
    maxJobs: 6,
  })
  assert.match(text, /The word for the medium is not the style/)
  assert.match(text, /never turn it photorealistic/)
  assert.match(text, /not even as a question at the end/)
  assert.match(text, /pass one of them in `reference`/)
  assert.match(text, /Each file\'s `seen:` belongs to that file/)
})

test('the instruction keeps a LoRA out of the tools, and forbids pushing the content further', async () => {
  const { agentInstruction } = await import('../server/vendor/tool-comfy/agent-prompt.ts')
  const text = await agentInstruction({
    request: { text: 'x', history: [], staged: [], recent: [], model: MODEL },
    known: [],
    eraseTool: false,
    working: [],
    maxSteps: 8,
    maxJobs: 6,
  })
  // 8: a LoRA is read-only, and the chat says so once and moves on.
  assert.match(text, /A LoRA is read-only/)
  assert.match(text, /never changed by the chat/)
  assert.match(text, /say once that the chat does not change it/)
  // 12: "sensuale" is not "nudo", and no lever pushes the content further.
  assert.match(text, /are not "nudo"/)
  assert.match(text, /never adds nudity/)
  assert.match(text, /do not present the result as what was asked/)
  // 3: the check is the truth, and the reply cannot deny it.
  assert.match(text, /never deny one of them/)
  assert.match(text, /carries `check`/)
  assert.match(text, /say which ones/)
})

test('an edit is compared with its source, and the reply carries what it lost', async () => {
  const ctx = seeingHost([JSON.stringify({
    requested_change_done: true,
    preserved_ok: { text: false },
    text_found: ['FRESH COFFEE'],
    unrequested_changes: [],
    identical_to_source: false,
    missing: ['the lettering OPEN'],
    description: 'the mug is blue',
  })])
  const { deps, model } = turn([
    toolCall('edit_image', { prompt: 'cambia il colore della tazza', source: 'photo.png' }),
    text('Fatto: la tazza ora è blu.'),
  ], { ctx, outputDir: mediaDir, text: 'cambia il colore della tazza' })
  const answer = await readAgentChat(deps)
  const toolMessage = (model.requests[1]?.messages ?? []).filter(message => message.role === 'tool').at(-1)
  const result = JSON.parse(toolMessage?.content ?? '{}') as {
    check?: { missing?: string[]; preserved_ok?: Record<string, boolean>; identical_to_source?: boolean }
  }
  assert.deepEqual(result.check?.missing, ['the lettering OPEN'])
  assert.deepEqual(result.check?.preserved_ok, { text: false })
  assert.equal(result.check?.identical_to_source, false)
  // The reply did not say it: the studio appends the check's own sentence.
  assert.match(answer.reply, /OPEN/)
  assert.match(answer.reply, /perso|has lost/)
})

test('a run that widens the content past the line is refused before it is queued', async () => {
  const generated = turn([
    toolCall('generate_image', { prompt: 'una donna nuda in un campo' }),
    text('No.'),
  ], { text: 'una donna in un campo, sensuale' })
  await readAgentChat(generated.deps)
  assert.equal(generated.started.length, 0)
  const refusal = JSON.parse(generated.model.requests[1]?.messages.at(-1)?.content ?? '{}') as { ok?: boolean; error?: string }
  assert.equal(refusal.ok, false)
  assert.match(refusal.error ?? '', /nudity/)
})

test('an edit that changes the frame the line did not ask to change is refused', async () => {
  // The fixture photo is 1:1; the line asks for no new shape.
  const { deps, started, model } = turn([
    toolCall('edit_image', { prompt: 'cambia il colore della tazza', source: 'photo.png', aspect: '9:16' }),
    text('No.'),
  ], { outputDir: mediaDir, text: 'cambia il colore della tazza' })
  await readAgentChat(deps)
  assert.equal(started.length, 0)
  const refusal = JSON.parse(model.requests[1]?.messages.at(-1)?.content ?? '{}') as { error?: string }
  assert.match(refusal.error ?? '', /did not ask to change the frame/)
})

test('an edit carries its spec and a verdict, and the report is built from the verdict', async () => {
  const ctx = seeingHost([JSON.stringify({
    requested_change_done: true,
    preserved_ok: { framing: true, text: false, subjects: true, style: true, format: true },
    text_found: ['FRESH COFFEE'],
    unrequested_changes: ['a bare breast nobody asked for'],
    identical_to_source: false,
    missing: ['the lettering OPEN'],
    description: 'the mug is blue',
  })])
  const { deps, model } = turn([
    toolCall('edit_image', { prompt: 'cambia il colore della tazza', source: 'photo.png' }),
    text('Fatto: la tazza è blu.'),
  ], { ctx, outputDir: mediaDir, text: 'cambia il colore della tazza' })
  const answer = await readAgentChat(deps)
  const toolMessage = (model.requests[1]?.messages ?? []).filter(message => message.role === 'tool').at(-1)
  const result = JSON.parse(toolMessage?.content ?? '{}') as {
    spec?: { preserve?: string[] }
    check?: { preserved_ok?: Record<string, boolean>; unrequested_changes?: string[]; text_found?: string[] }
  }
  assert.deepEqual(result.spec?.preserve, ['framing', 'text', 'subjects', 'style', 'format'])
  assert.deepEqual(result.check?.preserved_ok, { framing: true, text: false, subjects: true, style: true, format: true })
  assert.deepEqual(result.check?.unrequested_changes, ['a bare breast nobody asked for'])
  assert.deepEqual(result.check?.text_found, ['FRESH COFFEE'])
  // A change done, but not everything kept: partial, and the facts are named.
  assert.match(answer.reply, /Stato: parziale/)
  assert.match(answer.reply, /OPEN/)
  assert.match(answer.reply, /bare breast/)
})

test('a clean edit is reported as completed, from the verdict', async () => {
  const ctx = seeingHost([JSON.stringify({
    requested_change_done: true,
    preserved_ok: { framing: true, text: true, subjects: true, style: true, format: true },
    text_found: [],
    unrequested_changes: [],
    identical_to_source: false,
    missing: [],
    description: 'the mug is blue',
  })])
  const { deps } = turn([
    toolCall('edit_image', { prompt: 'cambia il colore della tazza', source: 'photo.png' }),
    text('Fatto.'),
  ], { ctx, outputDir: mediaDir, text: 'cambia il colore della tazza' })
  const answer = await readAgentChat(deps)
  assert.match(answer.reply, /Stato: completato/)
})

test('the same failed parameters are not run twice', async () => {
  const ctx = seeingHost([JSON.stringify({
    requested_change_done: false,
    preserved_ok: { framing: true, text: true, subjects: true, style: true, format: true },
    text_found: [],
    unrequested_changes: [],
    identical_to_source: false,
    missing: [],
    description: 'unchanged',
  })])
  const edit = { prompt: 'cambia il colore della tazza', source: 'photo.png' }
  const { deps, started, model } = turn([
    toolCall('edit_image', edit, 'call_1'),
    toolCall('edit_image', edit, 'call_2'),
    text('Non è cambiata.'),
  ], { ctx, outputDir: mediaDir, text: 'cambia il colore della tazza' })
  const answer = await readAgentChat(deps)
  assert.equal(started.length, 1, 'the same parameters were not queued a second time')
  const refusal = JSON.parse(((model.requests.at(-1)?.messages ?? []).filter(message => message.role === 'tool').at(-1)?.content) ?? '{}') as { error?: string }
  assert.match(refusal.error ?? '', /already tried/)
  assert.match(answer.reply, /Stato: fallito/)
})

test('a picture gets three attempts, then the turn stops and names the best', async () => {
  const no = JSON.stringify({
    requested_change_done: false,
    preserved_ok: { framing: true, text: true, subjects: true, style: true, format: true },
    text_found: [],
    unrequested_changes: [],
    identical_to_source: false,
    missing: ['the blue colour'],
    description: 'unchanged',
  })
  const ctx = seeingHost([no])
  const calls = [1, 2, 3, 4].map(n => toolCall('edit_image', { prompt: `cambia la tazza in blu, tentativo ${String(n)}`, source: 'photo.png' }, `call_${String(n)}`))
  const { deps, started, model } = turn([...calls, text('Mi fermo qui.')], { ctx, outputDir: mediaDir, text: 'cambia la tazza in blu' })
  const answer = await readAgentChat(deps)
  assert.equal(started.length, 3)
  const refusal = JSON.parse(((model.requests.at(-1)?.messages ?? []).filter(message => message.role === 'tool').at(-1)?.content) ?? '{}') as { error?: string }
  assert.match(refusal.error ?? '', /3 attempts/)
  assert.match(answer.reply, /Stato: fallito/)
  assert.match(answer.reply, /Il tentativo migliore/)
  assert.match(answer.reply, /Mi fermo dopo 3 tentativi/)
})

test('a reply that denies what the vision pass saw carries the pass sentence', async () => {
  await writeFile(join(mediaDir, 'job-1.webp'), ONE_PIXEL_PNG)
  const ctx = seeingHost(['the picture shows a woman, bare breast visible, no written text'])
  const { deps } = turn([
    toolCall('generate_image', { prompt: 'una donna in un campo' }),
    toolCall('look', { file: 'job-1.webp', question: 'is she dressed?' }, 'call_2'),
    text('Non l\'ho fatta nuda: la donna è vestita.'),
  ], { ctx, outputDir: mediaDir, text: 'una donna in un campo, sensuale' })
  const answer = await readAgentChat(deps)
  assert.match(answer.reply, /job-1\.webp/)
  assert.match(answer.reply, /bare breast/)
})

/** A generation graph with a LoRA that only runs when the prompt says "lanterna". */
function lanternInventory() {
  const graph = {
    '51': { class_type: 'CLIPTextEncode', inputs: { text: ['73', 0], clip: ['56', 0] } },
    '53': { class_type: 'KSampler', inputs: { seed: 1, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['k2', 0], positive: ['51', 0], negative: ['51', 0], latent_image: ['52', 0] } },
    '52': { class_type: 'EmptyLatentImage', inputs: { width: 1080, height: 1920, batch_size: 1 } },
    '55': { class_type: 'UNETLoader', inputs: { unet_name: 'base.safetensors', weight_dtype: 'default' } },
    '73': { class_type: 'PrimitiveStringMultiline', inputs: { value: '' } },
    '74': { class_type: 'StringContains', inputs: { string: ['73', 0], substring: 'lanterna', case_sensitive: false } },
    '76': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'lantern-glow.safetensors', strength_model: 0.6, model: ['55', 0] } },
    '78': { class_type: 'ComfySwitchNode', inputs: { switch: ['74', 0], on_false: ['55', 0], on_true: ['76', 0] } },
    k2: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'film-look.safetensors', strength_model: 0.75, model: ['78', 0] } },
  }
  return {
    list: [],
    cards: [],
    summarise: () => undefined,
    fields: () => undefined,
    facts: async () => undefined,
    warnings: () => undefined,
    overridden: () => false,
    plan: () => undefined,
    graphOf: (key: string) => key === 'generate' ? { graph, promptNodeId: '73', seedNodeId: '53' } : undefined,
  } as unknown as import('../server/vendor/tool-comfy/imagine-chat.ts').WorkflowInventory
}

test('the instruction tells the agent which word switches a LoRA on, and inspect_workflow lists the keys', async () => {
  const inventory = lanternInventory()
  const { deps, model } = turn([toolCall('inspect_workflow', { workflow: 'generate' }), text('Ho letto il grafo.')], { inventory })
  await readAgentChat(deps)
  const system = model.requests[0]?.messages.find(message => message.role === 'system')?.content ?? ''
  assert.match(system, /INSIDE THE GRAPHS/)
  assert.match(system, /lantern-glow" weight 0\.6 \(fixed: not a run setting\), ON ONLY WHEN the prompt contains "lanterna"/)
  const result = JSON.parse(model.requests[1]?.messages.at(-1)?.content ?? '{}') as {
    ok?: boolean
    loras?: { name: string; weight: number; readOnly?: boolean; needsWord?: string; key?: string }[]
    tweakable?: string[]
  }
  assert.equal(result.ok, true)
  assert.deepEqual(result.loras?.map(lora => [lora.name, lora.weight, lora.readOnly, lora.needsWord]), [
    ['lantern-glow', 0.6, true, 'lanterna'],
    ['film-look', 0.75, true, undefined],
  ])
  // A LoRA has no tweak key; the sampler does.
  assert.equal(result.loras?.some(lora => lora.key !== undefined), false)
  assert.equal(result.tweakable?.includes('76.strength_model'), false)
  assert.deepEqual(result.tweakable, ['53.steps', '53.cfg', '53.denoise', '53.sampler_name', '53.scheduler'])
})

test('a prompt that lost the word switching a LoRA on is sent back, and the run keeps it', async () => {
  const inventory = lanternInventory()
  const line = 'Genera una Lanterna in stile poster, 9:16'
  const { deps, started, model } = turn([
    toolCall('generate_image', { prompt: 'una luce in stile poster', aspect: '9:16' }),
    toolCall('generate_image', { prompt: 'una Lanterna in stile poster', aspect: '9:16' }, 'call_2'),
    text('Fatto.'),
  ], { inventory, text: line })
  await readAgentChat(deps)
  const results = (model.requests.at(-1)?.messages ?? [])
    .filter(message => message.role === 'tool')
    .map(message => JSON.parse(message.content) as { ok?: boolean; error?: string })
  assert.equal(results[0]?.ok, false)
  assert.match(results[0]?.error ?? '', /"lanterna"/)
  assert.equal(started.length, 1)
  assert.equal(started[0]?.prompt, 'una Lanterna in stile poster')
})

test('tweaks change a sampler value for this run only, and a LoRA weight is refused', async () => {
  const inventory = lanternInventory()
  const ok = turn([toolCall('generate_image', { prompt: 'un faro', tweaks: { '53.steps': 12 } }), text('Fatto.')], { inventory, text: 'un faro' })
  await readAgentChat(ok.deps)
  assert.deepEqual(ok.started[0]?.customFields, { '53.steps': 12 })
  const graph = inventory.graphOf?.('generate')?.graph as Record<string, { inputs: Record<string, unknown> }>
  assert.equal(graph['k2']?.inputs['strength_model'], 0.75, 'the stored graph is untouched')

  // The defect of 2026-11-21: the agent raised a LoRA weight by itself.
  for (const tweaks of [{ 'k2.strength_model': 0.3 }, { '76.lora_name': 'other.safetensors' }, { '74.substring': 'faro' }]) {
    const lora = turn([toolCall('generate_image', { prompt: 'un faro', tweaks }), text('No.')], { inventory, text: 'un faro' })
    await readAgentChat(lora.deps)
    assert.equal(lora.started.length, 0, `nothing runs with ${JSON.stringify(tweaks)}`)
    const refusal = JSON.parse(lora.model.requests[1]?.messages.at(-1)?.content ?? '{}') as { ok?: boolean; error?: string }
    assert.equal(refusal.ok, false)
    assert.match(refusal.error ?? '', /tweaks refused/)
    assert.match(refusal.error ?? '', /never changes a LoRA from the chat|never changes a switch/)
  }

  // The prompt and the seed stay the studio's, as before.
  const bad = turn([toolCall('generate_image', { prompt: 'un faro', tweaks: { '53.seed': 7, '73.value': 'altro' } }), text('No.')], { inventory, text: 'un faro' })
  await readAgentChat(bad.deps)
  assert.equal(bad.started.length, 0)
  const refusal = JSON.parse(bad.model.requests[1]?.messages.at(-1)?.content ?? '{}') as { error?: string }
  assert.match(refusal.error ?? '', /tweaks refused/)
})

test('the names the user wrote stay literal in the prompt', async () => {
  // A neutral fixture name: nobody's own pictures or person.
  const { subjectNames, lostNameRefusal } = await import('../server/vendor/tool-comfy/agent-tools.ts')
  assert.deepEqual(subjectNames('genera 10 foto di Nora Valle in stile fumetto'), ['Nora Valle'])
  assert.deepEqual(subjectNames('genera una foto di un faro al tramonto'), [])
  // A prompt that says "una donna" has lost the subject: the name is refused.
  assert.match(lostNameRefusal('genera 10 foto di Nora Valle', 'una donna in stile fumetto') ?? '', /Nora Valle/)
  // One word of the name is not the name either.
  assert.match(lostNameRefusal('genera 10 foto di Nora Valle', 'Nora in stile fumetto') ?? '', /Nora Valle/)
  assert.equal(lostNameRefusal('genera 10 foto di Nora Valle', 'Nora Valle in stile fumetto'), undefined)
})

test('a prompt that shortened the name is refused before any run, and the whole name runs', async () => {
  const shortened = turn([
    toolCall('generate_image', { prompt: 'una donna in stile fumetto', count: 10 }),
    text('Dieci foto in coda.'),
  ], { text: 'genera 10 foto di Nora Valle in stile fumetto' })
  await readAgentChat(shortened.deps)
  assert.equal(shortened.started.length, 0, 'nothing was queued with the wrong subject')
  const refusal = JSON.parse(shortened.model.requests[1]?.messages.at(-1)?.content ?? '{}') as { ok?: boolean; error?: string }
  assert.equal(refusal.ok, false)
  assert.match(refusal.error ?? '', /"Nora Valle"/)

  const kept = turn([
    toolCall('generate_image', { prompt: 'Nora Valle in stile fumetto, 9:16', count: 10 }),
    text('Dieci foto in coda.'),
  ], { text: 'genera 10 foto di Nora Valle in stile fumetto, 9:16' })
  const answer = await readAgentChat(kept.deps)
  assert.equal(kept.started[0]?.prompt, 'Nora Valle in stile fumetto, 9:16')
  assert.equal(answer.jobIds.length, 10)
})

test('a personal card takes ten pictures in one call and says ten', async () => {
  const inventory = {
    list: [],
    cards: [{ id: 'card-1', title: 'Ritratto pulito', description: '', inputs: [] }],
  } as unknown as import('../server/vendor/tool-comfy/imagine-chat.ts').WorkflowInventory
  const { deps, started, model } = turn([
    toolCall('run_card', { customWorkflowId: 'card-1', prompt: 'Nora Valle in stile fumetto', count: 10 }),
    text('Dieci foto in coda.'),
  ], { inventory, outputDir: mediaDir, text: 'genera 10 foto di Nora Valle con la card «Ritratto pulito»' })
  const first = await readAgentChat(deps)
  await readAgentChat({ ...deps, request: { ...deps.request, confirmation: { token: first.pending?.token ?? '', accept: true } } })
  assert.equal(started.length, 1)
  assert.equal(started[0]?.action, 'custom')
  assert.equal(started[0]?.count, 10)
  const result = JSON.parse(model.requests[1]?.messages.at(-1)?.content ?? '{}') as { count?: number }
  assert.equal(result.count, 10)
})
