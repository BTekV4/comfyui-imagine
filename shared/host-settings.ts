/**
 * The host's own settings page («General», GET/POST /api/host-settings): the
 * LLM gateway, the models the chip offers, the one model every pass talks to,
 * login and the resume at boot. The Instagram scheduler and Telegram's chat
 * used to be here too: both are plugin settings now.
 * Types only, read by both sides (until 2026-10-25 the page kept its own copy).
 */

import type { AgentChatMode } from './agent-chat.ts'
import type { ModelEntry, ModelRoute } from './imagine-types.ts'

/**
 * How much the model may think before writing, passed as
 * `reasoning_effort`.
 *
 * **The list is not ours**: the gateway declares it for each model in
 * `/v1/models` → `capabilities.effort_tiers` (for `strata/qwen3.8-flash-next`:
 * `["none","low","medium","xhigh"]`). The page's selector reads that, and the
 * day the gateway adds one it shows up by itself; all that stays here is the
 * shape by which a level is recognised, and the fallback to show when the
 * gateway does not answer.
 */
export type ThinkingLevel = string

/** The level in force when nobody has chosen anything. */
export const THINKING_DEFAULT: ThinkingLevel = 'low'

/**
 * The levels to show when the gateway does not answer: the only ones this
 * model declares today. They are not the truth, just the page's fallback.
 */
export const THINKING_FALLBACK: readonly ThinkingLevel[] = ['none', 'low', 'medium', 'xhigh']

/**
 * Whether a value has the shape of a level (`none`, `xhigh`, `minimal`…).
 * @param value - the value to check.
 * @returns whether it is a gateway-shaped tier name.
 */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,15}$/.test(value)
}

/** Every setting in force: `config.yaml` with the page's changes over it. */
export interface HostSettingsValues {
  readonly gatewayURL: string
  /** Set through the page; empty means "use OMNIROUTE_API_KEY from the env". */
  readonly apiKey: string
  readonly models: readonly ModelEntry[]
  /**
   * Chat, eyes and Instagram in one: since 2026-10-31 the page names a single
   * model, so the vision passes cannot drift from the one the chat shows.
   */
  readonly defaultModel: ModelRoute
  /** How long the model reasons before answering: every text and vision call. */
  readonly thinking: ThinkingLevel
  readonly resumeSweep: boolean
  readonly requireLogin: boolean
  /**
   * A Hugging Face token for the models that need one (gated repos): sent to
   * ComfyUI's Imagine Setup only for the downloads it makes, never shown back.
   */
  readonly hfToken: string
  /**
   * Install the node packs and models a request needs without asking first
   * (comfyui-imagine's setup). Off: the chat asks once per request.
   */
  readonly autoSetup: boolean
  /**
   * Which lane reads a written line: the agent when the model calls tools
   * (`auto`), the classic one-call reading (`off`), or the agent whatever the
   * model declares (`on`). See `docs/agent-chat.md`.
   */
  readonly agentChat: AgentChatMode
  /**
   * The agent's ceilings: model calls, runs a turn may queue, the wait for a
   * run, and the turn itself. A normal user never has to touch them.
   */
  readonly agentMaxSteps: number
  readonly agentMaxJobs: number
  readonly agentWaitSeconds: number
  readonly agentTurnSeconds: number
}

/** What the page is shown: the key is never sent back, only whether it is set. */
export type HostSettingsView = Omit<HostSettingsValues, 'apiKey' | 'hfToken'> & {
  readonly apiKeySet: boolean
  readonly hfTokenSet: boolean
  readonly apiKeyFromEnv: boolean
  readonly apiKeyTail: string
  readonly passwordSet: boolean
  /** Whether the resume sweep was on when this process started (it acts only then). */
  readonly bootResumeSweep: boolean
}

/** What the page saves: the fields it changed, the key and a new password. */
export type HostSettingsPatch = Partial<HostSettingsValues> & { readonly password?: string }
