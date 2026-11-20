/**
 * The agent chat: the loop, its tools and the switch, shared by the server and
 * the page.
 *
 * Until 2026-11-18 the chat inside a project was one JSON call: one reading,
 * one fixed shape. The agent lane lets the model call tools (queue a still,
 * edit one, erase something, look at a file, read the project, check a run)
 * and answers with the runs it queued. The classic lane stays as the reserve,
 * chosen by the settings switch or by a model that cannot call tools.
 *
 * Types only, read by both sides.
 */

import type { ImagineChatAsk, ImagineChatIntent, WorkflowProposal } from './imagine-chat.ts'
import type { MediaFileRef } from './imagine-types.ts'

/**
 * What the chat does with a written line:
 * `auto` = the agent when the model declares (or a cached probe finds) tool
 * calling, the classic lane otherwise; `off` = classic always; `on` = the
 * agent whatever the model declares.
 */
export const AGENT_CHAT_MODES = ['auto', 'off', 'on'] as const

/** One setting of the agent switch. */
export type AgentChatMode = typeof AGENT_CHAT_MODES[number]

/**
 * Whether a value is a mode the settings page may store.
 * @param value - the value to check.
 * @returns whether it is one of {@link AGENT_CHAT_MODES}.
 */
export function isAgentChatMode(value: unknown): value is AgentChatMode {
  return typeof value === 'string' && (AGENT_CHAT_MODES as readonly string[]).includes(value)
}

/** The budgets one agent turn is bounded by, read from the settings. */
export interface AgentLimits {
  /** Model calls in one turn. */
  readonly maxSteps: number
  /** Runs a turn may queue. */
  readonly maxJobs: number
  /** How long one turn waits for a run before answering "it is still running". */
  readonly waitSeconds: number
  /** Hard ceiling of a turn. */
  readonly turnSeconds: number
  /** A clip longer than this is confirmed before it is queued. */
  readonly confirmSeconds: number
}

/**
 * The most runs one turn may queue, however many the user asked for.
 *
 * `maxJobs` is the ordinary budget: what a turn queues when the line asks for
 * no particular number. A line that says "fai 10 foto" gets at least ten, so
 * the budget follows the request instead of refusing a number the user named;
 * this is the ceiling that keeps one sentence from filling a GPU for a day.
 */
export const AGENT_JOBS_CEILING = 24

/** The confirmed limits: a normal user never has to touch them. */
export const AGENT_LIMITS_DEFAULT: AgentLimits = {
  // A turn with three tools is typically four or five model calls.
  maxSteps: 8,
  maxJobs: 6,
  waitSeconds: 300,
  turnSeconds: 900,
  // The owner's rule (2026-11-18): a clip up to fifteen seconds runs without
  // asking; longer ones, and every chain, are confirmed first.
  confirmSeconds: 15,
}

/**
 * What one agent turn asks for: the written-lane body plus the project the
 * runs belong to. The model route and the language travel as they do in the
 * classic lane (the body and the `x-app-language` header).
 */
export interface AgentChatAsk extends ImagineChatAsk {
  /** The board project the runs are adopted into, when the page has one. */
  readonly projectId?: string
  /** The voices installed on this host, filled by the server as the classic lane does. */
  readonly voices?: readonly string[]
  /** The interface's language, filled by the server from the request header. */
  readonly language?: string
  /**
   * The answer to a confirmation the agent asked for: the token it sent, and
   * whether the user said yes. A body carrying this resumes the same turn;
   * the line itself is not read again.
   */
  readonly confirmation?: AgentConfirmation
}

/** One answer to a pending confirmation. */
export interface AgentConfirmation {
  /** The token of the {@link AgentPending} the page showed. */
  readonly token: string
  /** True when the user said yes; false stops the action and tells the model. */
  readonly accept: boolean
}

/**
 * A piece of work the agent stopped before doing, waiting for the user's yes.
 *
 * The loop never starts a run that costs more than the owner allowed without
 * this: the token resumes the same turn, and a reload loses it (a pending
 * action is not worth persisting).
 */
export interface AgentPending {
  /** Opaque, single use, and only known to the page that received it. */
  readonly token: string
  /** The tool that stopped: `make_video`, `upscale`, `cancel_job`, … */
  readonly tool: string
  /** The studio action it would run, when there is one. */
  readonly action?: string
  /** What stops: `run` starts work, `cancel` stops a run. */
  readonly kind: 'run' | 'cancel'
  /** One line for the card, already in the interface's language. */
  readonly summary: string
  /** The length it would render, when the cost is a length. */
  readonly seconds?: number
  /** The file it starts from, when it starts from one. */
  readonly source?: string
  /** The personal card's title, when a card is what would run. */
  readonly card?: string
  /** The run a cancel offer is about. */
  readonly jobId?: string
  /** When the offer stops being valid (epoch milliseconds). */
  readonly expiresAt: number
}

/** One tool call the model asked for, accumulated off the stream. */
export interface AgentToolCall {
  readonly id: string
  readonly name: string
  /** The arguments as the model wrote them, JSON text: checked before use. */
  readonly arguments: string
}

/** One message of a tool-aware conversation, in the shape the gateway reads. */
export interface AgentChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  /** Assistant only: the calls this message answers for. */
  readonly toolCalls?: readonly AgentToolCall[]
  /** Tool only: the call this result belongs to. */
  readonly toolCallId?: string
}

/** One tool the model may call, as the gateway declares it. */
export interface AgentToolSchema {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Readonly<Record<string, unknown>>
  }
}

/** What one streamed model call emits. */
export type AgentModelEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | {
    readonly type: 'tool-call'
    readonly index: number
    readonly id?: string
    readonly name?: string
    readonly arguments?: string
  }
  | { readonly type: 'finish'; readonly reason?: string }

/** One request to the tool-aware model client. */
export interface AgentModelRequest {
  readonly provider: string
  readonly model: string
  readonly messages: readonly AgentChatMessage[]
  readonly tools?: readonly AgentToolSchema[]
  readonly toolChoice?: 'auto' | 'none' | 'required'
  /** One call at a time: the trace is one line per action, and the queue is serial. */
  readonly parallelToolCalls?: boolean
  readonly signal?: AbortSignal
  /** A bounded call (the capability probe); the silence clock bounds every other one. */
  readonly deadlineMs?: number
}

/**
 * The model client's tool-aware half. The host's `llm` implements it beside
 * the streaming surface the classic passes read.
 */
export interface AgentModelCapable {
  chat(options: AgentModelRequest): AsyncIterable<AgentModelEvent>
}

/** What a gateway declares about a model in `/v1/models`. */
export interface AgentCapabilities {
  /** `capabilities.tool_calling`, when the gateway says. */
  readonly toolCalling?: boolean
  /** `capabilities.vision`, when the gateway says. */
  readonly vision?: boolean
}

/**
 * What one agent turn did: the reply, the runs it queued, and the lane that
 * answered. The classic lane answers with `intents`, which the page runs as it
 * always did; the agent lane queues the runs itself and answers with their ids.
 */
export interface AgentChatAnswer {
  /** Which lane read the line. */
  readonly mode: 'agent' | 'classic'
  /** The assistant's answer, in the interface's language. */
  readonly reply: string
  /** The runs the agent queued, in order. */
  readonly jobIds: readonly string[]
  /** Files the turn made without a job (the masked removal), when any. */
  readonly files: readonly MediaFileRef[]
  /** Classic lane only: the runs the page has to start. */
  readonly intents: readonly ImagineChatIntent[]
  /** Classic lane only: a workflow change waiting for a yes. */
  readonly proposal?: WorkflowProposal
  /** True when the reading came from the model rather than from the fallback. */
  readonly read: boolean
  /** Why the classic lane answered, when the agent was skipped. */
  readonly skipped?: 'off' | 'no-tools' | 'failed'
  /** True when a queued run had not settled by the turn's wait ceiling. */
  readonly running?: boolean
  /**
   * Work the loop stopped before doing, waiting for the user's yes.
   *
   * The turn ends here with no reply of its own: the page shows the card, and
   * the answer to it resumes the same turn (see {@link AgentChatAsk.confirmation}).
   */
  readonly pending?: AgentPending
  /** The classic lane's failure flag, kept so the page says the same thing. */
  readonly failed?: boolean
}

/**
 * Whether one answer started anything: a run, a host-made file, a classic
 * intent, or an offer waiting for a yes.
 *
 * The column prints "No work started" on a reading that only answered. That
 * line is only true when nothing at all was queued: a turn that put ten runs
 * in the queue must never be followed by it (2026-11-20, the agent chat of a
 * project: the reply offered ten pictures and the line read "No work
 * started"). The rule is here, not in the page, so it can be tested without
 * one.
 * @param answer - what the reading came back with.
 * @returns true when the answer queued, made or offered something.
 */
export function answerStartedWork(answer: {
  readonly pending?: unknown
  readonly intents: readonly unknown[]
  readonly jobIds: readonly unknown[]
  readonly files: readonly unknown[]
}): boolean {
  return answer.pending !== undefined
    || answer.intents.length > 0
    || answer.jobIds.length > 0
    || answer.files.length > 0
}
