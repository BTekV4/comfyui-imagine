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

/**
 * One LoRA the owner listed in Settings → General: what it is for, the word
 * that switches it on, and the weight they want.
 *
 * The studio does not read LoRA files (they live on the ComfyUI box, outside
 * this repository) and it never guesses what one does from its name: the
 * owner writes the purpose in their own words, and this is the only place it
 * is kept. A catalog entry with no purpose is refused on save.
 */
export interface LoraEntry {
  /** The LoRA tag as ComfyUI names it (the loader's own string). */
  readonly file: string
  /** What it does, in the owner's words: "il volto di <chi>", "luce da studio". */
  readonly purpose: string
  /**
   * The word or phrase that switches it on inside the prompt, when the graph
   * reads a word: it has to appear literally in the text for the branch to
   * fire, so it is kept exactly as written.
   */
  readonly trigger?: string
  /** The strength the owner recommends, when the graph writes one. */
  readonly weight?: number
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
  /** A clip longer than this is confirmed before it is queued. */
  readonly agentConfirmSeconds: number
  /**
   * The LoRA catalog the owner wrote, when they wrote one. Absent or empty is
   * the normal case: a deployment that uses no LoRA of its own.
   */
  readonly loraCatalog?: readonly LoraEntry[]
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
  /**
   * The provider `config.yaml` defines for the gateway address the page shows,
   * matched by baseURL. The catalog writes this name on a model it adds: the
   * provider has to be one the config defines, or the chat refuses the model
   * with `llm.unknownProvider` (F2 wrote `omniroute` on a config using `local`).
   */
  readonly gatewayProvider: string
}

/** What the page saves: the fields it changed, the key and a new password. */
export type HostSettingsPatch = Partial<HostSettingsValues> & { readonly password?: string }
