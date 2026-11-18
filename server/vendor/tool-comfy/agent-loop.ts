/**
 * The agent loop: pick the route, build the instruction, call the model, run
 * the tool calls it asks for, wait for the runs, and write the reply.
 *
 * The loop lives on the server because the queue, the jobs, the media folder,
 * the notes and the vision client are server state: a turn can outlast the tab
 * that asked for it, and the budgets and the lane belong in one place.
 *
 * The lane is chosen per turn: the settings switch first, then what the
 * gateway declares (`capabilities.tool_calling`), then one cached probe for a
 * model that declares nothing — a local endpoint such as Strata's own
 * `/v1/models`, which publishes no capabilities at all. No route with tools
 * means the classic lane, which is what the chat was before this existed.
 * @module tool-comfy/agent-loop
 */

import { message } from '../../src/messages.ts'
import type { ImagineHost } from '../../src/host.ts'
import type {
  AgentCapabilities, AgentChatAsk, AgentChatAnswer, AgentChatMessage, AgentChatMode, AgentLimits,
  AgentModelCapable, AgentModelEvent, AgentToolCall,
} from '../../../shared/agent-chat.ts'
import type { ImagineChatEvent } from '../../../shared/imagine-chat.ts'
import type { ImagineJobView, MediaFileRef, ModelRoute } from '../../../shared/imagine-types.ts'
import { readImagineChat, type ImagineChatRequest, type WorkflowInventory } from './imagine-chat.ts'
import { textRoutes } from './imagine-models.ts'
import { whenJobsSettle, type ImagineJob } from './job-queue.ts'
import type { JobBody } from './job-start.ts'
import { agentInstruction, finalReplyAsk } from './agent-prompt.ts'
import { agentToolSchemas, runAgentTool, type AgentToolDeps } from './agent-tools.ts'

/** What the host hands the loop: the switch, the limits and the declarations. */
export interface AgentSurface {
  /** The mode in force, read on every turn (a save applies at once). */
  readonly mode: () => AgentChatMode
  /** The budgets in force. */
  readonly limits: () => AgentLimits
  /** What the gateway declares about one route; empty when it says nothing. */
  readonly capabilities: (route: ModelRoute) => Promise<AgentCapabilities>
  /** The studio's own address, for the plugin routes the tools call. */
  readonly selfURL?: string
}

/** The studio's side of one agent turn. */
export interface AgentTurnDeps {
  readonly ctx: ImagineHost
  readonly request: AgentChatAsk
  readonly inventory?: WorkflowInventory
  readonly outputDir: string
  /** The board project the runs are adopted into. */
  readonly projectId?: string
  /** Whether the eraser plugin is mounted. */
  readonly eraseTool: boolean
  /** The interface's language (the `x-app-language` header). */
  readonly language?: string
  readonly modelClient: AgentModelCapable
  readonly surface: AgentSurface
  /** Starts one run: the route's `startFromBody`, or a fake in the tests. */
  readonly start: (body: JobBody) => Promise<readonly ImagineJob[]>
  /** One run with its live progress. */
  readonly jobView: (job: ImagineJob) => ImagineJobView
  /** The jobs still in memory. */
  readonly listJobs: () => readonly ImagineJob[]
  /** One job by id, when it is still in memory. */
  readonly getJob: (id: string) => ImagineJob | undefined
  /** Puts a host-made file into the project. */
  readonly adoptFiles: (names: readonly string[]) => Promise<void>
  /** The page's abort: the stop button, or a closed tab. */
  readonly signal?: AbortSignal
  /** Told about every step, as it happens. */
  readonly say: (event: ImagineChatEvent) => void
}

/** The probe's answer, cached for the life of the process, per route. */
const probeAnswers = new Map<string, Promise<boolean>>()

/** How long the capability probe may take before the classic lane wins. */
const PROBE_DEADLINE_MS = 40_000

/** One trivial tool: enough to see whether the route can call one. */
const PROBE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'probe',
    description: 'Probe tool: call it with no arguments.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
}

/** How often a wait reports the run it is following. */
const WAIT_TICK_MS = 800

/**
 * Read one written line in the agent lane, or in the classic one when the
 * switch and the model say so.
 * @param deps - the turn's state.
 * @returns the answer, in whichever lane read it.
 */
export async function readAgentChat(deps: AgentTurnDeps): Promise<AgentChatAnswer> {
  const mode = deps.surface.mode()
  const routes = textRoutes(deps.request.model)
  const chosen = await chooseRoute(mode, routes, deps)
  if (chosen.route === undefined) {
    return await classicAnswer(deps, chosen.skipped)
  }
  try {
    return await runAgentTurn(deps, chosen.route)
  } catch (error: unknown) {
    /*
     * Nothing was queued: the classic lane reads the line instead of the turn
     * dying on a model that answered something unusable. A turn that did
     * queue runs is returned by the loop itself, never thrown.
     */
    console.warn(`[imagine] agent ${chosen.route.provider}/${chosen.route.model}: ${error instanceof Error ? error.message : String(error)}`)
    deps.say({ kind: 'step', step: 'fallback', detail: 'agent-failed' })
    return await classicAnswer(deps, 'failed')
  }
}

/**
 * Which lane reads this line, and on which route.
 * @param mode - the setting in force.
 * @param routes - the text routes, best first.
 * @param deps - the turn, for the declarations and the probe.
 * @returns the route, or the reason the classic lane takes the line.
 */
async function chooseRoute(
  mode: AgentChatMode,
  routes: readonly ModelRoute[],
  deps: AgentTurnDeps,
): Promise<{ readonly route?: ModelRoute; readonly skipped?: 'off' | 'no-tools' }> {
  if (mode === 'off') return { skipped: 'off' }
  for (const route of routes) {
    // The forced switch does not ask the gateway: the user said use the agent.
    if (mode === 'on') return { route }
    const declared = await deps.surface.capabilities(route).catch((): AgentCapabilities => ({}))
    if (declared.toolCalling === true) return { route }
    if (declared.toolCalling === false) continue
    if (await probeTools(deps.modelClient, route)) return { route }
  }
  return { skipped: 'no-tools' }
}

/**
 * One cached probe: can this route produce a tool call at all?
 *
 * For a model that publishes no capabilities — a local llama.cpp or Strata's
 * own endpoint — this is the only honest answer. Cached per route for the life
 * of the process, so the cost is paid once.
 * @param client - the tool-aware model client.
 * @param route - the route to probe.
 * @returns whether the route called the probe tool.
 */
export function probeTools(client: AgentModelCapable, route: ModelRoute): Promise<boolean> {
  const key = `${route.provider}\u001f${route.model}`
  const known = probeAnswers.get(key)
  if (known !== undefined) return known
  const started = (async (): Promise<boolean> => {
    try {
      for await (const event of client.chat({
        provider: route.provider,
        model: route.model,
        messages: [
          { role: 'system', content: 'Call the probe tool now, with no arguments. Do not answer in words.' },
          { role: 'user', content: 'go' },
        ],
        tools: [PROBE_TOOL],
        toolChoice: 'required',
        deadlineMs: PROBE_DEADLINE_MS,
      })) {
        if (event.type === 'tool-call') return true
      }
      return false
    } catch {
      return false
    }
  })()
  probeAnswers.set(key, started)
  return started
}

/**
 * The classic lane's answer, in the agent's envelope.
 * @param deps - the turn.
 * @param skipped - why the agent was not used, when it was not.
 * @returns the reading the page already knows how to run.
 */
async function classicAnswer(
  deps: AgentTurnDeps,
  skipped?: 'off' | 'no-tools' | 'failed',
): Promise<AgentChatAnswer> {
  const asked: ImagineChatRequest = {
    ...deps.request,
    ...deps.language === undefined ? {} : { language: deps.language },
  }
  const reply = await readImagineChat(deps.ctx, asked, deps.inventory, deps.outputDir, deps.say, deps.signal)
  return {
    mode: 'classic',
    reply: reply.reply,
    jobIds: [],
    files: [],
    intents: reply.intents,
    read: reply.read,
    ...reply.proposal === undefined ? {} : { proposal: reply.proposal },
    ...skipped === undefined ? {} : { skipped },
    ...reply.failed === true ? { failed: true } : {},
  }
}

/** What one streamed model call produced. */
interface Collected {
  readonly text: string
  readonly calls: readonly AgentToolCall[]
  readonly finish?: string
}

/**
 * Read one streamed model call: the text, the reasoning and the tool calls.
 * @param events - the stream.
 * @param say - told about the reasoning as it arrives.
 * @returns the whole call.
 */
async function collect(
  events: AsyncIterable<AgentModelEvent>,
  say: (event: ImagineChatEvent) => void,
): Promise<Collected> {
  let text = ''
  let finish: string | undefined
  const calls = new Map<number, { id: string; name: string; args: string }>()
  for await (const event of events) {
    if (event.type === 'text-delta') text += event.text
    else if (event.type === 'reasoning-delta') say({ kind: 'reasoning', text: event.text })
    else if (event.type === 'finish') finish = event.reason
    else {
      const current = calls.get(event.index) ?? { id: '', name: '', args: '' }
      if (event.id !== undefined) current.id = event.id
      if (event.name !== undefined) current.name = event.name
      if (event.arguments !== undefined) current.args += event.arguments
      calls.set(event.index, current)
    }
  }
  return {
    text: text.trim(),
    finish,
    calls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([index, call]) => ({
      id: call.id.length > 0 ? call.id : `call_${String(index)}`,
      name: call.name,
      arguments: call.args,
    })),
  }
}

/**
 * The agent's own turn.
 * @param deps - the turn.
 * @param route - the tool-capable route.
 * @returns the answer; the runs it queued are never lost, whatever the model did.
 */
async function runAgentTurn(deps: AgentTurnDeps, route: ModelRoute): Promise<AgentChatAnswer> {
  const limits = deps.surface.limits()
  const turnDeadline = Date.now() + limits.turnSeconds * 1_000
  const known = [...deps.request.staged ?? [], ...deps.request.recent ?? []]
  const instruction = await agentInstruction({
    request: deps.request,
    known,
    eraseTool: deps.eraseTool,
    working: deps.request.working ?? [],
    ...deps.language === undefined ? {} : { language: deps.language },
    maxSteps: limits.maxSteps,
    maxJobs: limits.maxJobs,
  })
  const messages: AgentChatMessage[] = [
    { role: 'system', content: instruction },
    ...(deps.request.history ?? []).map(entry => ({ role: entry.role, content: entry.text })),
    { role: 'user', content: deps.request.text },
  ]
  const schemas = agentToolSchemas().filter(tool => tool.function.name !== 'erase' || deps.eraseTool)
  const jobs: ImagineJob[] = []
  const files: MediaFileRef[] = []
  const toolDeps: AgentToolDeps = {
    ctx: deps.ctx,
    outputDir: deps.outputDir,
    ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
    ...deps.request.model === undefined ? {} : { model: deps.request.model },
    ...deps.language === undefined ? {} : { language: deps.language },
    asked: deps.request.text,
    ...deps.signal === undefined ? {} : { signal: deps.signal },
    eraseTool: deps.eraseTool,
    ...deps.surface.selfURL === undefined ? {} : { selfURL: deps.surface.selfURL },
    start: deps.start,
    jobView: deps.jobView,
    listJobs: deps.listJobs,
    getJob: deps.getJob,
    adoptFiles: deps.adoptFiles,
    known,
    canQueue: () => Math.max(0, limits.maxJobs - jobs.length),
    say: deps.say,
  }
  deps.say({ kind: 'step', step: 'route', detail: `${route.provider}/${route.model}` })
  let reply = ''
  let contained = false
  /** Set when a run outlived the wait: the turn closes instead of polling on. */
  let gaveUpWaiting = false
  for (let step = 1; step <= limits.maxSteps; step++) {
    if (deps.signal?.aborted === true) break
    if (Date.now() >= turnDeadline) break
    let collected: Collected
    try {
      collected = await collect(deps.modelClient.chat({
        provider: route.provider,
        model: route.model,
        messages,
        tools: schemas,
        toolChoice: 'auto',
        parallelToolCalls: false,
        ...deps.signal === undefined ? {} : { signal: deps.signal },
      }), deps.say)
    } catch (error: unknown) {
      if (jobs.length === 0) throw error
      console.warn(`[imagine] agent: ${error instanceof Error ? error.message : String(error)}`)
      contained = true
      break
    }
    if (collected.calls.length === 0) {
      // The model stopped calling tools: its text is the reply.
      reply = collected.text
      break
    }
    messages.push({ role: 'assistant', content: collected.text, toolCalls: collected.calls })
    let ranOut = false
    for (const call of collected.calls) {
      if (Date.now() >= turnDeadline) { ranOut = true; break }
      const parsed = parseArguments(call.arguments)
      const outcome = typeof parsed === 'string'
        ? { result: { ok: false, error: parsed }, jobs: [] as readonly ImagineJob[], files: [] as readonly MediaFileRef[] }
        : await runAgentTool(call.name, parsed, toolDeps)
      // The runs this call queued join the turn's, then the loop waits for them.
      const queued = outcome.jobs.filter(job => !jobs.some(seen => seen.id === job.id))
      jobs.push(...queued)
      files.push(...outcome.files.filter(file => !files.some(seen => seen.name === file.name)))
      const waited = queued.length === 0
        ? { all: true, anyRunning: false }
        : await waitForJobs(queued, deps, turnDeadline, limits.waitSeconds)
      // The queue's live copies: the start returned the jobs as they were
      // queued, and only the map knows what each of them made.
      const lived = queued.map(job => deps.getJob(job.id) ?? job)
      const result = waited.all && queued.length > 0
        ? { ...outcome.result, state: finalState(lived), files: lived.flatMap(job => job.files?.map(file => file.name) ?? []) }
        : waited.anyRunning && queued.length > 0
        ? { ...outcome.result, state: 'running', waiting: 'the run is still going; the result appears in the chat when it is done' }
        : outcome.result
      messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) })
      // The wait is the turn's whole patience with a run: past it the reply
      // says "still running" and the result appears in the chat by itself.
      // Polling the model further would only keep the spinner alive.
      if (waited.anyRunning) { gaveUpWaiting = true; break }
    }
    if (ranOut || gaveUpWaiting) break
  }
  /*
   * The model did not write a reply — it used every step on tools, or the turn
   * hit its ceiling. One last call with no tools asks for it, so the chat never
   * ends with nothing to read.
   */
  if (reply.length === 0) {
    try {
      const last = await collect(deps.modelClient.chat({
        provider: route.provider,
        model: route.model,
        messages: [...messages, { role: 'user', content: finalReplyAsk(deps.language) }],
        ...deps.signal === undefined ? {} : { signal: deps.signal },
      }), () => undefined)
      reply = last.text
    } catch {
      // The reply below still says something true about the runs.
    }
  }
  // The queue's live copy, not the snapshot the start returned: it was queued
  // when the array was built and only the map knows it finished.
  const running = jobs.some(job => !settled(deps.getJob(job.id) ?? job))
  if (reply.length === 0) {
    reply = running
      ? message('chat.agentStillRunning')
      : contained ? message('chat.agentFailed') : message('chat.agentEmpty')
  }
  return {
    mode: 'agent',
    reply,
    jobIds: jobs.map(job => job.id),
    files,
    intents: [],
    read: true,
    ...running ? { running: true } : {},
  }
}

/**
 * Wait for the runs one call queued, reporting where they are.
 *
 * Event-driven, not a poll: `whenJobsSettle` wakes on the queue's own writes.
 * A second clock ticks the progress at a human pace while the first waits, so
 * the page can say "42%" without turning the wait into a busy loop.
 * @param jobs - the runs to wait for.
 * @param deps - the turn, for the queue view.
 * @param turnDeadline - the turn's ceiling.
 * @param waitSeconds - how long one turn may wait.
 * @returns whether every run settled, and whether any was still running.
 */
async function waitForJobs(
  jobs: readonly ImagineJob[],
  deps: AgentTurnDeps,
  turnDeadline: number,
  waitSeconds: number,
): Promise<{ readonly all: boolean; readonly anyRunning: boolean }> {
  const until = Math.min(turnDeadline, Date.now() + waitSeconds * 1_000)
  const ids = jobs.map(job => job.id)
  const beat = setInterval(() => {
    for (const job of jobs) {
      const view = deps.jobView(deps.getJob(job.id) ?? job)
      const progress = view.progress
      deps.say({
        kind: 'step',
        step: 'waiting',
        jobId: job.id,
        ...progress?.percent === undefined ? {} : { percent: progress.percent },
        ...progress?.nodeClass === undefined ? {} : { stage: progress.nodeClass },
      })
    }
  }, WAIT_TICK_MS)
  beat.unref()
  try {
    await whenJobsSettle(ids, Math.max(0, until - Date.now()))
  } finally {
    clearInterval(beat)
  }
  const remaining = ids.filter(id => {
    const job = deps.getJob(id)
    return job !== undefined && !settled(job)
  })
  return { all: remaining.length === 0, anyRunning: remaining.length > 0 }
}

/** Whether a run stopped moving. */
function settled(job: ImagineJob): boolean {
  return job.status === 'done' || job.status === 'error' || job.status === 'cancelled'
}

/**
 * The word for the set of runs one call queued.
 * @param jobs - the runs.
 * @returns `done` when every one finished, else the first terminal word.
 */
function finalState(jobs: readonly ImagineJob[]): string {
  if (jobs.every(job => job.status === 'done')) return 'done'
  const failed = jobs.find(job => job.status === 'error')
  if (failed !== undefined) return 'error'
  const cancelled = jobs.find(job => job.status === 'cancelled')
  return cancelled === undefined ? 'done' : 'cancelled'
}

/**
 * The model's arguments, parsed as the object the tools take.
 * @param raw - the JSON text the model streamed.
 * @returns the object, or the sentence saying why it is not one.
 */
function parseArguments(raw: string): Readonly<Record<string, unknown>> | string {
  if (raw.trim().length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : 'the arguments are not a JSON object'
  } catch {
    return `the arguments are not valid JSON: ${raw.slice(0, 200)}`
  }
}
