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

import { randomUUID } from 'node:crypto'
import { message } from '../../src/messages.ts'
import type { ImagineHost } from '../../src/host.ts'
import { AGENT_JOBS_CEILING } from '../../../shared/agent-chat.ts'
import type {
  AgentCapabilities, AgentChatAsk, AgentChatAnswer, AgentChatMessage, AgentChatMode, AgentLimits,
  AgentModelCapable, AgentModelEvent, AgentPending, AgentToolCall,
} from '../../../shared/agent-chat.ts'
import type { ImagineChatEvent } from '../../../shared/imagine-chat.ts'
import type { ImagineJobView, MediaFileRef, ModelRoute } from '../../../shared/imagine-types.ts'
import { readImagineChat, type ImagineChatRequest, type WorkflowInventory } from './imagine-chat.ts'
import { textRoutes } from './imagine-models.ts'
import { whenJobsSettle, type ImagineJob } from './job-queue.ts'
import type { JobBody } from './job-start.ts'
import { agentInstruction, finalReplyAsk } from './agent-prompt.ts'
import { replyNeedsRewrite, rewriteAsk } from './reply-language.ts'
import { join } from 'node:path'
import { probeMedia } from './media-tools.ts'
import {
  agentToolSchemas, confirmationFor, numbersInLine, runAgentTool, type AgentPendingOffer, type AgentToolDeps,
  type AgentToolOutcome,
} from './agent-tools.ts'

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
  /** Stops a run, after the user confirmed the agent's offer to cancel it. */
  readonly cancelJob: (id: string) => Promise<boolean>
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
  // An answer to a confirmation resumes the turn it belongs to, not a new one.
  if (deps.request.confirmation !== undefined) return await resumeAgentChat(deps)
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

/** What one agent turn carries between steps, and across a confirmation. */
interface TurnState {
  readonly route: ModelRoute
  readonly messages: AgentChatMessage[]
  readonly jobs: ImagineJob[]
  readonly files: MediaFileRef[]
  step: number
  /** When the turn itself stops, in epoch milliseconds. */
  deadline: number
  readonly known: readonly MediaFileRef[]
  readonly asked: string
  readonly model?: ModelRoute
  readonly projectId?: string
  readonly language?: string
  reply: string
  gaveUpWaiting: boolean
  contained: boolean
  /** A queued run waits for the user to approve an install on ComfyUI. */
  setup?: { readonly what: string; readonly jobIds: readonly string[] }
  /** Calls of an assistant message already written, to run after a resume. */
  cursor?: { readonly calls: readonly AgentToolCall[]; readonly index: number }
}

/** One turn stopped before a confirmed action, kept in memory until answered. */
interface PendingSession {
  readonly token: string
  readonly offer: AgentPendingOffer
  readonly call: AgentToolCall
  readonly args: Readonly<Record<string, unknown>>
  readonly calls: readonly AgentToolCall[]
  readonly index: number
  readonly state: TurnState
  /** How much of the turn was left when the offer was made. */
  readonly remainingMs: number
  readonly createdAt: number
}

/**
 * The confirmations waiting for an answer, by token.
 *
 * In memory on purpose: the design says a reload asks again, because a
 * pending action is not worth persisting across a restart, and a token that
 * outlived the process would resume a turn whose runs are gone.
 */
const pendingSessions = new Map<string, PendingSession>()

/** How long an unanswered confirmation stays valid. */
const PENDING_TTL_MS = 10 * 60_000

/** How many confirmations one process keeps at once. */
const PENDING_MAX = 100

/** The tool deps of one turn, rebuilt from the state a confirmation resumed. */
function toolDepsOf(deps: AgentTurnDeps, state: TurnState): AgentToolDeps {
  return {
    ctx: deps.ctx,
    outputDir: deps.outputDir,
    ...state.projectId === undefined ? {} : { projectId: state.projectId },
    ...state.model === undefined ? {} : { model: state.model },
    ...state.language === undefined ? {} : { language: state.language },
    asked: state.asked,
    ...previousUserLine(deps.request.history) === undefined ? {} : { previous: previousUserLine(deps.request.history) as string },
    ...deps.signal === undefined ? {} : { signal: deps.signal },
    eraseTool: deps.eraseTool,
    ...deps.surface.selfURL === undefined ? {} : { selfURL: deps.surface.selfURL },
    ...deps.inventory === undefined ? {} : { inventory: deps.inventory },
    ...deps.request.voices === undefined ? {} : { voices: deps.request.voices },
    start: deps.start,
    jobView: deps.jobView,
    listJobs: deps.listJobs,
    getJob: deps.getJob,
    adoptFiles: deps.adoptFiles,
    cancelJob: deps.cancelJob,
    known: state.known,
    canQueue: () => Math.max(0, jobBudgetFor(deps.surface.limits(), state.asked, previousUserLine(deps.request.history)) - state.jobs.length),
    say: deps.say,
  }
}

/**
 * How many runs this turn may queue: the setting, or the number the line asked
 * for when that is larger, up to {@link AGENT_JOBS_CEILING}.
 *
 * The budget used to be the setting alone (six by default), so "fai 10 foto"
 * was refused with "this turn has already queued all the runs it may" while
 * nothing at all was queued: the tool said a count above six could not fit a
 * budget that had not been touched. A number the user names is a budget.
 * @param limits - the turn's limits, as the settings hold them.
 * @param asked - the user's line.
 * @returns the runs this turn may queue.
 */
export function jobBudgetFor(limits: AgentLimits, asked: string, previous?: string): number {
  const own = numbersInLine(asked).count
  const repeated = own === undefined && previous !== undefined && isRetryLine(asked)
    ? numbersInLine(previous).count
    : undefined
  return Math.min(AGENT_JOBS_CEILING, Math.max(limits.maxJobs, own ?? repeated ?? 0))
}

/** Whether the line asks for the previous request again. */
function isRetryLine(asked: string): boolean {
  return /^(riprova|rifallo|fallo (di nuovo|ancora)|try again|do it again)\b/i.test(asked.trim())
}

/**
 * The last line the user wrote before this turn: a "riprova" repeats it, so
 * its number is the number this turn has to finish.
 * @param history - the conversation the page sent, oldest first.
 * @returns that line, when there is one.
 */
function previousUserLine(history: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[] | undefined): string | undefined {
  return (history ?? []).filter(entry => entry.role === 'user').at(-1)?.text
}

/** A tool result with the language the reply has to be written in. */
function forModel(
  result: Readonly<Record<string, unknown>>,
  language: string | undefined,
): Readonly<Record<string, unknown>> {
  return language === undefined ? result : { ...result, reply_language: language }
}

/**
 * The agent's own turn.
 * @param deps - the turn.
 * @param route - the tool-capable route.
 * @returns the answer; the runs it queued are never lost, whatever the model did.
 */
async function runAgentTurn(deps: AgentTurnDeps, route: ModelRoute): Promise<AgentChatAnswer> {
  const limits = deps.surface.limits()
  const known = [...deps.request.staged ?? [], ...deps.request.recent ?? []]
  const instruction = await agentInstruction({
    request: deps.request,
    known,
    eraseTool: deps.eraseTool,
    working: deps.request.working ?? [],
    ...deps.language === undefined ? {} : { language: deps.language },
    maxSteps: limits.maxSteps,
    maxJobs: jobBudgetFor(limits, deps.request.text, previousUserLine(deps.request.history)),
    ...deps.inventory?.cards === undefined ? {} : { cards: deps.inventory.cards },
    ...deps.request.voices === undefined ? {} : { voices: deps.request.voices },
  })
  deps.say({ kind: 'step', step: 'route', detail: `${route.provider}/${route.model}` })
  const state: TurnState = {
    route,
    messages: [
      { role: 'system', content: instruction },
      ...(deps.request.history ?? []).map(entry => ({ role: entry.role, content: entry.text })),
      { role: 'user', content: deps.request.text },
    ],
    jobs: [],
    files: [],
    step: 1,
    deadline: Date.now() + limits.turnSeconds * 1_000,
    known,
    asked: deps.request.text,
    ...deps.request.model === undefined ? {} : { model: deps.request.model },
    ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
    ...deps.language === undefined ? {} : { language: deps.language },
    reply: '',
    gaveUpWaiting: false,
    contained: false,
  }
  return await driveTurn(deps, state)
}

/**
 * Resume a turn that stopped for a confirmation: run the offered call when the
 * user said yes, refuse it when they said no, and let the model write its
 * reply with the rest of the step.
 * @param deps - the turn whose `request.confirmation` carries the answer.
 * @returns the rest of the turn.
 */
async function resumeAgentChat(deps: AgentTurnDeps): Promise<AgentChatAnswer> {
  const answer = deps.request.confirmation
  if (answer === undefined) return expiredAnswer()
  const session = pendingSessions.get(answer.token)
  pendingSessions.delete(answer.token)
  if (session === undefined || Date.now() > session.createdAt + PENDING_TTL_MS) return expiredAnswer()
  const limits = deps.surface.limits()
  const state: TurnState = {
    ...session.state,
    messages: [...session.state.messages],
    jobs: [...session.state.jobs],
    files: [...session.state.files],
    deadline: Date.now() + session.remainingMs,
    reply: '',
    gaveUpWaiting: false,
    contained: false,
  }
  const toolDeps = toolDepsOf(deps, state)
  if (answer.accept) {
    const outcome = await runAgentTool(session.call.name, session.args, toolDeps)
    const queued = outcome.jobs.filter(job => !state.jobs.some(seen => seen.id === job.id))
    state.jobs.push(...queued)
    state.files.push(...outcome.files.filter(file => !state.files.some(seen => seen.name === file.name)))
    const waited = queued.length === 0
      ? { all: true, anyRunning: false, setup: [] as readonly ImagineJob[] }
      : await waitForJobs(queued, deps, state.deadline, limits.waitSeconds)
    const lived = queued.map(job => deps.getJob(job.id) ?? job)
    const result = await waitedResult(outcome, waited, lived, deps.outputDir)
    state.messages.push({ role: 'tool', toolCallId: session.call.id, content: JSON.stringify(forModel(result, state.language)) })
    if (waited.setup.length > 0) {
      state.setup = { what: setupWhat(waited.setup), jobIds: waited.setup.map(job => job.id) }
      state.gaveUpWaiting = true
      closeRemainingCalls(state, session.calls, session.index + 1, 'not run: an earlier run waits for the user to approve an install on ComfyUI')
    } else if (waited.anyRunning) {
      state.gaveUpWaiting = true
      closeRemainingCalls(state, session.calls, session.index + 1, 'not run: an earlier run is still going')
    } else {
      state.cursor = { calls: session.calls, index: session.index + 1 }
    }
  } else {
    /*
     * A declined cancel is answered with the run's own state: the model must
     * not say "it is still queued" when the GPU has already finished it.
     */
    const live = session.offer.jobId === undefined ? undefined : deps.getJob(session.offer.jobId)
    state.messages.push({
      role: 'tool',
      toolCallId: session.call.id,
      content: JSON.stringify(forModel({
        ok: false,
        error: 'the user declined this action. Do not run it again in this turn; ask what to change if it is still what they want.',
        ...live === undefined ? {} : { job: { id: live.id, action: live.action, state: live.status } },
      }, state.language)),
    })
    state.cursor = { calls: session.calls, index: session.index + 1 }
  }
  if (state.gaveUpWaiting) return await finishTurn(deps, state)
  return await driveTurn(deps, state)
}

/** The answer a token that is gone or too old gets. */
function expiredAnswer(): AgentChatAnswer {
  return {
    mode: 'agent',
    reply: message('agent.confirmExpired'),
    jobIds: [],
    files: [],
    intents: [],
    read: true,
  }
}

/**
 * The loop itself, from the state it is in: one model call, its tool calls,
 * the waits, and the reply. Called for a new turn and again after a
 * confirmation, so both paths share every ceiling and every rule.
 * @param deps - the turn.
 * @param state - what the turn has done so far.
 * @returns the answer.
 */
async function driveTurn(deps: AgentTurnDeps, state: TurnState): Promise<AgentChatAnswer> {
  const limits = deps.surface.limits()
  const schemas = agentToolSchemas().filter(tool => tool.function.name !== 'erase' || deps.eraseTool)
  for (let step = state.step; step <= limits.maxSteps; step++) {
    state.step = step
    if (deps.signal?.aborted === true) break
    if (Date.now() >= state.deadline) break
    let calls: readonly AgentToolCall[]
    let startIndex: number
    if (state.cursor !== undefined) {
      calls = state.cursor.calls
      startIndex = state.cursor.index
      state.cursor = undefined
    } else {
      let collected: Collected
      try {
        collected = await collect(deps.modelClient.chat({
          provider: state.route.provider,
          model: state.route.model,
          messages: state.messages,
          tools: schemas,
          toolChoice: 'auto',
          parallelToolCalls: false,
          ...deps.signal === undefined ? {} : { signal: deps.signal },
        }), deps.say)
      } catch (error: unknown) {
        if (state.jobs.length === 0) throw error
        console.warn(`[imagine] agent: ${error instanceof Error ? error.message : String(error)}`)
        state.contained = true
        break
      }
      if (collected.calls.length === 0) {
        // The model stopped calling tools: its text is the reply.
        state.reply = collected.text
        break
      }
      state.messages.push({ role: 'assistant', content: collected.text, toolCalls: collected.calls })
      calls = collected.calls
      startIndex = 0
    }
    let ranOut = false
    let nextIndex = startIndex
    for (let index = startIndex; index < calls.length; index++) {
      nextIndex = index
      if (Date.now() >= state.deadline) { ranOut = true; break }
      const call = calls[index] as AgentToolCall
      const parsed = parseArguments(call.arguments)
      if (typeof parsed === 'string') {
        state.messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(forModel({ ok: false, error: parsed }, state.language)) })
        nextIndex = index + 1
        continue
      }
      /*
       * A run that costs a chain, or a clip past the owner's limit, stops here:
       * the turn ends with an offer, and the page's yes resumes it. Nothing is
       * queued and nothing is cancelled before that answer.
       */
      const offer = confirmationFor(call.name, parsed, state.asked, limits.confirmSeconds, toolDepsOf(deps, state))
      if (offer !== undefined) {
        const token = randomUUID().replace(/-/g, '')
        const now = Date.now()
        prunePending(now)
        pendingSessions.set(token, {
          token, offer, call, args: parsed, calls, index,
          state: {
            ...state,
            messages: [...state.messages],
            jobs: [...state.jobs],
            files: [...state.files],
          },
          remainingMs: Math.max(0, state.deadline - now),
          createdAt: now,
        })
        const pending: AgentPending = {
          token,
          ...offer,
          expiresAt: now + PENDING_TTL_MS,
        }
        deps.say({ kind: 'step', step: 'confirm', detail: offer.summary })
        return {
          mode: 'agent',
          reply: '',
          jobIds: state.jobs.map(job => job.id),
          files: state.files,
          intents: [],
          read: true,
          pending,
        }
      }
      const outcome = await runAgentTool(call.name, parsed, toolDepsOf(deps, state))
      // The runs this call queued join the turn's, then the loop waits for them.
      const queued = outcome.jobs.filter(job => !state.jobs.some(seen => seen.id === job.id))
      state.jobs.push(...queued)
      state.files.push(...outcome.files.filter(file => !state.files.some(seen => seen.name === file.name)))
      const waited = queued.length === 0
        ? { all: true, anyRunning: false, setup: [] as readonly ImagineJob[] }
        : await waitForJobs(queued, deps, state.deadline, limits.waitSeconds)
      // The queue's live copies: the start returned the jobs as they were
      // queued, and only the map knows what each of them made.
      const lived = queued.map(job => deps.getJob(job.id) ?? job)
      const result = await waitedResult(outcome, waited, lived, deps.outputDir)
      state.messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(forModel(result, state.language)) })
      // The wait is the turn's whole patience with a run: past it the reply
      // says "still running" and the result appears in the chat by itself.
      // Polling the model further would only keep the spinner alive.
      nextIndex = index + 1
      if (waited.setup.length > 0) {
        state.setup = { what: setupWhat(waited.setup), jobIds: waited.setup.map(job => job.id) }
        state.gaveUpWaiting = true
        closeRemainingCalls(state, calls, index + 1, 'not run: an earlier run waits for the user to approve an install on ComfyUI')
        nextIndex = calls.length
        break
      }
      if (waited.anyRunning) {
        state.gaveUpWaiting = true
        closeRemainingCalls(state, calls, index + 1, 'not run: an earlier run is still going')
        nextIndex = calls.length
        break
      }
    }
    if (ranOut) {
      closeRemainingCalls(state, calls, nextIndex, 'not run: the turn reached its ceiling')
      break
    }
    if (state.gaveUpWaiting) break
  }
  return await finishTurn(deps, state)
}

/**
 * The end of a turn: one last call without tools when the model wrote no
 * reply, and the sentence that says what happened when even that fails.
 * @param deps - the turn.
 * @param state - what it queued.
 * @returns the answer.
 */
async function finishTurn(deps: AgentTurnDeps, state: TurnState): Promise<AgentChatAnswer> {
  /*
   * A run waiting for the user to approve an install is not a run in
   * progress: the model must not be given a chance to call it "in corso". The
   * reply is the fact and the button to press, in the interface's language.
   */
  if (state.setup !== undefined) {
    state.reply = message('agent.waitingSetup', { what: state.setup.what })
  }
  /*
   * The model did not write a reply — it used every step on tools, or the turn
   * hit its ceiling. One last call with no tools asks for it, so the chat never
   * ends with nothing to read.
   */
  if (state.reply.length === 0) {
    try {
      const last = await collect(deps.modelClient.chat({
        provider: state.route.provider,
        model: state.route.model,
        messages: [...state.messages, { role: 'user', content: finalReplyAsk(state.language) }],
        ...deps.signal === undefined ? {} : { signal: deps.signal },
      }), () => undefined)
      state.reply = last.text
    } catch {
      // The reply below still says something true about the runs.
    }
  }
  /*
   * A reply written in another language is asked for once more, with the
   * reply itself and no tools: the trace the model read is English JSON, and
   * a sentence in English is the one fault the instruction alone did not
   * always prevent. One rewrite, never a loop.
   */
  if (state.reply.length > 0 && replyNeedsRewrite(state.reply, state.language)) {
    const rewritten = await rewriteReply(deps, state)
    if (rewritten !== undefined) state.reply = rewritten
  }
  // The queue's live copy, not the snapshot the start returned: it was queued
  // when the array was built and only the map knows it finished. A run waiting
  // for its install is not "running" here: its own sentence says that.
  const setupIds = new Set(state.setup?.jobIds ?? [])
  const live = state.jobs.map(job => deps.getJob(job.id) ?? job)
  const running = live.some(job => !settled(job) && !setupIds.has(job.id))
  if (state.reply.length === 0) {
    const failed = live.find(job => job.status === 'error' && job.error !== undefined)
    state.reply = running
      ? message('chat.agentStillRunning')
      : failed?.error !== undefined ? message('agent.runFailed', { error: failed.error })
      : state.contained ? message('chat.agentFailed') : message('chat.agentEmpty')
  }
  return {
    mode: 'agent',
    reply: state.reply,
    jobIds: state.jobs.map(job => job.id),
    files: state.files,
    intents: [],
    read: true,
    ...running ? { running: true } : {},
  }
}

/**
 * Ask the model to write its reply again, in the interface's language.
 * @param deps - the turn.
 * @param state - the turn's state, with the reply to rewrite.
 * @returns the rewritten text, or undefined when the call failed or was empty.
 */
async function rewriteReply(deps: AgentTurnDeps, state: TurnState): Promise<string | undefined> {
  try {
    const last = await collect(deps.modelClient.chat({
      provider: state.route.provider,
      model: state.route.model,
      messages: [
        ...state.messages,
        { role: 'assistant', content: state.reply },
        { role: 'user', content: rewriteAsk(state.language) },
      ],
      ...deps.signal === undefined ? {} : { signal: deps.signal },
    }), () => undefined)
    const text = last.text.trim()
    if (text.length === 0) return undefined
    deps.say({ kind: 'step', step: 'rewrite', detail: state.language ?? '?' })
    return text
  } catch {
    return undefined
  }
}

/** Answer the calls of a message the turn will not run, so the wire stays valid. */
function closeRemainingCalls(state: TurnState, calls: readonly AgentToolCall[], from: number, why: string): void {
  for (let index = from; index < calls.length; index++) {
    const call = calls[index] as AgentToolCall
    state.messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(forModel({ ok: false, error: why }, state.language)) })
  }
}

/** Drop confirmations nobody answered, and keep the map bounded. */
function prunePending(now: number): void {
  for (const [token, session] of pendingSessions) {
    if (now > session.createdAt + PENDING_TTL_MS) pendingSessions.delete(token)
  }
  while (pendingSessions.size >= PENDING_MAX) {
    const oldest = pendingSessions.keys().next().value
    if (oldest === undefined) break
    pendingSessions.delete(oldest)
  }
}

/**
 * Wait for the runs one call queued, reporting where they are.
 *
 * Event-driven, not a poll: `whenJobsSettle` wakes on the queue's own writes.
 * A second clock ticks the progress at a human pace while the first waits, so
 * the page can say "42%" without turning the wait into a busy loop. A run that
 * waits for the user to approve an install (`setup-needed`) ends the wait: the
 * GPU is not working on it, and the turn has to say what is missing instead of
 * "still running".
 * @param jobs - the runs to wait for.
 * @param deps - the turn, for the queue view.
 * @param turnDeadline - the turn's ceiling.
 * @param waitSeconds - how long one turn may wait.
 * @returns whether every run settled, whether any was still running, and the
 *   runs waiting for an install.
 */
async function waitForJobs(
  jobs: readonly ImagineJob[],
  deps: AgentTurnDeps,
  turnDeadline: number,
  waitSeconds: number,
): Promise<{ readonly all: boolean; readonly anyRunning: boolean; readonly setup: readonly ImagineJob[] }> {
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
    await whenJobsSettle(ids, Math.max(0, until - Date.now()), job => job.notice === 'setup-needed')
  } finally {
    clearInterval(beat)
  }
  const setup = ids
    .map(id => deps.getJob(id))
    .filter((job): job is ImagineJob => job !== undefined && !settled(job) && job.notice === 'setup-needed')
  const waiting = new Set(setup.map(job => job.id))
  const remaining = ids.filter((id) => {
    const job = deps.getJob(id)
    return job !== undefined && !settled(job) && !waiting.has(id)
  })
  return { all: remaining.length === 0 && setup.length === 0, anyRunning: remaining.length > 0, setup }
}

/**
 * The tool result of one call whose runs were waited for: finished, waiting for
 * an install, or still going. The setup case says so in words the model can
 * repeat; "still running" for a run that waits for the user is the F2 fault.
 * @param outcome - what the tool made.
 * @param waited - how the wait ended.
 * @param lived - the runs as the queue has them now.
 * @returns the object the model reads.
 */
async function waitedResult(
  outcome: AgentToolOutcome,
  waited: { readonly all: boolean; readonly anyRunning: boolean; readonly setup: readonly ImagineJob[] },
  lived: readonly ImagineJob[],
  outputDir: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (waited.setup.length > 0) {
    return {
      ...outcome.result,
      state: 'setup-needed',
      missing: waited.setup.flatMap(job => setupMissing(job)),
      note: 'the run is not rendering: it waits for the user to approve an install on ComfyUI. Tell them what is missing.',
    }
  }
  if (waited.all && lived.length > 0) {
    /*
     * The files with their real measures: the model used to get bare names,
     * so it could not see that a "9:16" edit came back 3:4 and said it was
     * done (2026-11-19). An error carries its reason for the same cause.
     */
    const names = lived.flatMap(job => job.files?.map(file => file.name) ?? [])
    const made = await Promise.all(names.map(async name => await measured(join(outputDir, name), name)))
    const asked = typeof outcome.result['aspect'] === 'string' ? outcome.result['aspect'] : undefined
    const off = asked === undefined ? [] : made.filter(file => file.ratio !== undefined && !sameShape(file.width, file.height, asked))
    const askedSeconds = typeof outcome.result['seconds'] === 'number' ? outcome.result['seconds'] : undefined
    const short = askedSeconds === undefined
      ? []
      : made.filter(file => file.duration !== undefined && Math.abs(file.duration - askedSeconds) > 2)
    const errors = lived.filter(job => job.status === 'error').map(job => job.error ?? 'the run failed without a reason')
    const mismatch = [
      ...off.length === 0 ? [] : [`asked ${asked ?? ''}, made ${off.map(file => `${file.name} ${file.ratio ?? '?'}`).join(', ')}`],
      ...short.length === 0 ? [] : [`asked ${String(askedSeconds)} s, made ${short.map(file => `${file.name} ${file.duration?.toFixed(1) ?? '?'} s`).join(', ')}`],
    ]
    return {
      ...outcome.result,
      state: finalState(lived),
      files: made,
      ...errors.length === 0 ? {} : { errors },
      ...mismatch.length === 0 ? {} : { mismatch: mismatch.join('; ') },
    }
  }
  if (waited.anyRunning && lived.length > 0) {
    return { ...outcome.result, state: 'running', waiting: 'the run is still going; the result appears in the chat when it is done' }
  }
  return outcome.result
}

/** One made file with its real measures, when ffprobe can read them. */
async function measured(
  path: string,
  name: string,
): Promise<{ name: string; width?: number; height?: number; ratio?: string; duration?: number }> {
  const probe = await probeMedia(path).catch(() => undefined)
  const width = probe?.width
  const height = probe?.height
  const duration = probe?.duration
  return {
    name,
    ...width === undefined || height === undefined || width <= 0 || height <= 0 ? {} : { width, height, ratio: ratioName(width, height) },
    ...duration === undefined || duration <= 0 ? {} : { duration },
  }
}

/** The nearest common ratio, as the studio spells it. */
function ratioName(width: number, height: number): string {
  const shapes = ['1:1', '9:16', '16:9', '3:4', '4:3', '2:3', '3:2', '4:5', '5:4', '21:9']
  const value = width / height
  let best = shapes[0] ?? '1:1'
  for (const shape of shapes) {
    if (Math.abs(Math.log(value / shapeValue(shape))) < Math.abs(Math.log(value / shapeValue(best)))) best = shape
  }
  return best
}

/** A ratio's value, width over height. */
function shapeValue(shape: string): number {
  const [w, h] = shape.split(':').map(Number)
  return w !== undefined && h !== undefined && h > 0 ? w / h : 1
}

/** Whether a file has the asked shape, within 3%. */
function sameShape(width: number | undefined, height: number | undefined, asked: string): boolean {
  if (width === undefined || height === undefined || height <= 0) return true
  return Math.abs(Math.log((width / height) / shapeValue(asked))) < 0.03
}

/** What a run's setup plan is missing, as the model should say it. */
function setupMissing(job: ImagineJob): string[] {
  const plan = job.setup
  if (plan === undefined) return []
  const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`
  return [
    ...plan.packs.map(pack => pack.name),
    ...plan.models.map(model => `${model.name} (${gb(model.size)})`),
  ]
}

/** What the runs waiting for an install need, in one clause. */
function setupWhat(jobs: readonly ImagineJob[]): string {
  const names = [...new Set(jobs.flatMap(job => setupMissing(job)))]
  return names.length === 0 ? 'a model or a node pack ComfyUI does not have' : names.join(', ')
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
