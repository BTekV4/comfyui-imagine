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
import {
  probeTools, readAgentChat, type AgentTurnDeps,
} from '../server/vendor/tool-comfy/agent-loop.ts'
import { putJob, type ImagineJob } from '../server/vendor/tool-comfy/job-queue.ts'
import { choicesInLine } from '../server/vendor/tool-comfy/agent-tools.ts'
import type { ImagineHost } from '../server/src/host.ts'
import type {
  AgentChatAsk, AgentModelEvent, AgentModelRequest, AgentToolSchema,
} from '../shared/agent-chat.ts'
import type { ImagineChatEvent } from '../shared/imagine-chat.ts'
import type { JobBody } from '../server/vendor/tool-comfy/job-start.ts'
import { sizeFor } from '../shared/imagine-sizing.ts'

const MODEL = { provider: 'fake', model: 'fake' } as const

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
    limits?: { maxSteps: number; maxJobs: number; waitSeconds: number; turnSeconds: number }
    mode?: 'auto' | 'off' | 'on'
    capabilities?: { toolCalling?: boolean; vision?: boolean }
    ctx?: ImagineHost
  } = {},
) {
  const model = scriptedModel(scripts)
  const started: JobBody[] = []
  const events: ImagineChatEvent[] = []
  const jobs = new Map<string, ImagineJob>()
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
    outputDir: '/nonexistent-imagine-agent-test',
    projectId: 'project-1',
    eraseTool: false,
    modelClient: model,
    surface: {
      mode: () => options.mode ?? 'on',
      limits: () => options.limits ?? { maxSteps: 8, maxJobs: 6, waitSeconds: 300, turnSeconds: 900 },
      capabilities: async () => options.capabilities ?? { toolCalling: true },
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
    adoptFiles: async () => undefined,
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
  const { deps, model, started } = turn(scripts, { limits: { maxSteps: 2, maxJobs: 6, waitSeconds: 300, turnSeconds: 900 } })
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
      limits: () => ({ maxSteps: 8, maxJobs: 6, waitSeconds: 0, turnSeconds: 900 }),
      capabilities: async () => ({ toolCalling: true }),
    },
    start: async () => [running],
    jobView: job => job,
    listJobs: () => [running],
    getJob: id => id === running.id ? running : undefined,
    adoptFiles: async () => undefined,
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
