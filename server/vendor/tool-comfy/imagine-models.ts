/**
 * Which model Imagine talks to.
 *
 * Imagine has passes that need a model and no GPU — the chat inside a
 * project, the story director, the free rewrite of a look — and passes that
 * must actually see the file. The host names one model for each
 * (`models.text`, `models.vision`, set from its settings page); the model the
 * composer's chip shows wins over both, so every pass runs on the model the
 * user can see. With no chip in play, the last one it showed.
 *
 * History, kept because the rule came from it: in DSH these passes borrowed
 * the harness's vision override, which named a cloud model behind the
 * studio's back — the chip said Qwen3.8 while mimo on opencode wrote every
 * clip's prompt — and when that model timed out the clip went to H3 as a bare
 * line and sang (2026-09-21).
 * @module tool-comfy/imagine-models
 */

import { randomUUID } from 'node:crypto'
import type { ImagineHost } from '../../src/host.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'

/** The models this deployment gave Imagine of its own. */
export interface ImagineModels {
  /** Chat reading, story direction, look rewriting: text in, text out. */
  readonly text?: ModelRoute
  /** The passes that look at the file itself, which need a model that can see. */
  readonly vision?: ModelRoute
}

/**
 * What the plugin was configured with, set once at install.
 *
 * Module state rather than a parameter on nine signatures: the job runner,
 * the story director and the look rewriter are reached through four layers
 * that carry nothing else the plugin configured, and the jobs map beside them
 * is held the same way.
 */
let configured: ImagineModels = {}

/**
 * Record the models this deployment gave Imagine.
 * @param models - the plugin's `models` config, empty when it has none.
 */
export function setImagineModels(models: ImagineModels): void {
  configured = models
  lastChosen = undefined
}

/** A route with both halves actually written; anything else is not a route. */
function usable(route: ModelRoute | undefined): ModelRoute | undefined {
  return typeof route?.provider === 'string' && route.provider.length > 0
    && typeof route.model === 'string' && route.model.length > 0
    ? { provider: route.provider, model: route.model }
    : undefined
}

/**
 * The last model the studio's chip reported.
 *
 * The passes that run without a request in hand — a file looked at the moment
 * it lands, a chat reading that sent no route — still belong to the model the
 * user picked, so the pick is remembered as it goes past.
 */
let lastChosen: ModelRoute | undefined

/**
 * Remember the model the chip is showing.
 * @param route - the route a request carried, ignored when half-written.
 */
function noteChosenModel(route: ModelRoute | undefined): void {
  lastChosen = usable(route) ?? lastChosen
}

/**
 * The models to try for a text pass, best first.
 *
 * A list rather than one route because a model can be picked in the studio
 * that cannot answer at all — an image model, a route that is down — and the
 * alternative to trying the next one is a silent fallback that generates the
 * user's sentence instead of reading it.
 * @param chosen - the model the studio is showing, when the caller has one.
 * @returns the routes to try in order, without repeats.
 */
export function textRoutes(chosen?: ModelRoute): readonly ModelRoute[] {
  noteChosenModel(chosen)
  const order = [usable(chosen), usable(configured.text), lastChosen]
  const kept: ModelRoute[] = []
  for (const route of order) {
    if (route === undefined) continue
    if (kept.some(seen => seen.provider === route.provider && seen.model === route.model)) continue
    kept.push(route)
  }
  return kept
}

/**
 * The model for a pass that has to look at the file.
 *
 * The deployment's own vision model comes first, the chip only when none is
 * configured. The chip is a list of chat models: one of them can be a route
 * that cannot see at all, and a model that cannot see asked to describe a
 * photo invents a person instead of saying so. Measured 2026-10-28: with
 * `strata/qwen3.8-flash-next` picked in the composer, the identity read of a
 * blonde festival selfie came back as "straight dark-brown shoulder-length
 * hair, teal satin top, black sequined bottoms ... text overlay SELFIE" — a
 * description of nobody in either file. The swap then kept the plate's face
 * and changed only the clothes (ArcFace `ref` -0,07 / `src` 0,85), and the
 * change it did make was the wardrobe the invented text asked for.
 * @param chosen - the model the job or request carried, when it had one.
 * @returns the route to look with, or undefined when nothing names a model.
 */
export function visionRoute(chosen?: ModelRoute): ModelRoute | undefined {
  noteChosenModel(chosen)
  return usable(configured.vision) ?? usable(chosen) ?? lastChosen
}

/**
 * A second model to look through, when the deployment has one.
 *
 * The edit prompt falls back on it when the first reader does not answer
 * (`edit-prompt.ts`). No second route is not a reason to refuse the run — the
 * single read stands.
 * @param chosen - the model the job or request carried, when it had one.
 * @returns a route different from the vision one, or undefined.
 */
export function secondVisionRoute(chosen?: ModelRoute): ModelRoute | undefined {
  const first = visionRoute(chosen)
  return textRoutes(chosen).find(route => route.provider !== first?.provider || route.model !== first?.model)
}

/**
 * The LLM surface Imagine's text passes need, read off the context when set.
 *
 * The message shape is what `createUserMessage` produces, built by the caller
 * rather than imported: these plugins talk to the model through the context
 * they are handed and do not depend on the llm package to do it. `signal` is
 * honoured by the runtime, which settles the stream promptly once it aborts.
 */
export interface StreamCapable {
  stream(options: {
    provider: string
    model: string
    messages: readonly unknown[]
    signal?: AbortSignal
  }): AsyncIterable<{ type: string; text?: string }>
}

/** What a running {@link streamText} reports as it goes. */
export interface StreamTextHooks {
  /** A reasoning delta, when the route emits thinking. */
  readonly onReasoning?: (text: string) => void
  /** Called once, when the first text delta arrives. */
  readonly onWriting?: () => void
  /** Stops the call from outside, e.g. the chat closing its stream. */
  readonly signal?: AbortSignal
}

/**
 * Read one instruction to text, never throwing, with no clock of its own.
 *
 * The shared scaffold behind the chat reading, the music score and the story
 * plan: it accumulates the text deltas, reports reasoning and the first write
 * through the hooks, and returns undefined when the model failed or produced
 * nothing.
 *
 * The deadline this function used to carry (`timeoutMs`, ninety to three
 * hundred seconds depending on the pass) is gone (user's decision,
 * 16/11/2026): it killed the story planner at 90 s while the provider in
 * `config.yaml` was allowed 600, and a model that is still sending tokens —
 * reasoning included — is not a model that failed. The only bound is the
 * silence clock inside the model client (`server/src/llm.ts`), which gives up
 * on a connection that sends no bytes and pushes back on every delta.
 * @param llm - the streaming surface.
 * @param target - the provider and model to read with.
 * @param instruction - the prompt.
 * @param hooks - optional observers of reasoning and the first write, and the caller's abort.
 * @returns the text, or undefined when it failed or was empty.
 */
export async function streamText(
  llm: StreamCapable,
  target: { provider: string; model: string },
  instruction: string,
  hooks?: StreamTextHooks,
): Promise<string | undefined> {
  const outside = hooks?.signal
  if (outside?.aborted === true) return undefined
  // Aborts the request when the caller stops waiting, e.g. a chat that closed
  // its stream: the model must not keep thinking for nobody.
  const controller = new AbortController()
  const stop = (): void => { controller.abort() }
  outside?.addEventListener('abort', stop, { once: true })
  try {
    let text = ''
    let writing = false
    for await (const chunk of llm.stream({
      provider: target.provider,
      model: target.model,
      messages: [{
        id: randomUUID(),
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: instruction }],
      }],
      signal: controller.signal,
    })) {
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        hooks?.onReasoning?.(chunk.text)
      }
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        if (!writing) {
          writing = true
          hooks?.onWriting?.()
        }
        text += chunk.text
      }
    }
    return text.trim().length === 0 ? undefined : text
  } catch {
    return undefined
  } finally {
    controller.abort()
    outside?.removeEventListener('abort', stop)
  }
}

/**
 * The vision surface the looking passes read off the context.
 *
 * Six modules declared this shape on their own until 2026-10-20.
 */
export interface VisionCapable {
  analyzeImage(
    image: string,
    prompt?: string,
    route?: { provider: string; model: string },
    options?: { signal?: AbortSignal; maxSide?: number; also?: readonly string[] },
  ): Promise<{ text: string; provider?: string; model?: string }>
}

/** The vision service on the context, when it is mounted. */
export function visionOf(ctx: ImagineHost): VisionCapable | undefined {
  const auxiliary: VisionCapable | undefined = ctx.auxiliary
  return typeof auxiliary?.analyzeImage === 'function' ? auxiliary : undefined
}

/**
 * How many looks may be in flight across the whole studio.
 *
 * `lookAtShots` used to send every photo of a montage at once, and the rest
 * only queued at the model with their timers already running.
 */
const VISION_PARALLEL = 4

/**
 * How many of those looks may be background ones: the descriptions filed
 * ahead of time for every still of an opened project (up to a couple of
 * hundred, 38-59 s each). With one shared queue a chat line waited behind
 * the whole backlog; capped here, a look someone is waiting for always finds
 * a slot the backlog cannot take, and is served before any background look
 * that is still waiting.
 */
const BACKGROUND_PARALLEL = 2

let lookingNow = 0
let backgroundNow = 0
const waitingToLook: (() => void)[] = []
const waitingInBackground: (() => void)[] = []

/**
 * Hand free slots to the waiters, foreground first.
 *
 * A slot is counted for the waiter before it wakes: counted only when it
 * woke, a new caller arriving in between saw room and took the same slot,
 * one look over the ceiling.
 */
function dispatchLooks(): void {
  while (lookingNow < VISION_PARALLEL) {
    const next = waitingToLook.shift()
    if (next !== undefined) {
      lookingNow += 1
      next()
      continue
    }
    if (backgroundNow >= BACKGROUND_PARALLEL) return
    const later = waitingInBackground.shift()
    if (later === undefined) return
    lookingNow += 1
    backgroundNow += 1
    later()
  }
}

/**
 * Wait for a free look, and hand back the call that frees it.
 * @param background - a look nobody is waiting for, in the capped lane.
 * @returns the release.
 */
async function lookSlot(background: boolean): Promise<() => void> {
  const free = lookingNow < VISION_PARALLEL && (background
    ? backgroundNow < BACKGROUND_PARALLEL && waitingToLook.length === 0
    : true)
  if (free) {
    lookingNow += 1
    if (background) backgroundNow += 1
  } else {
    await new Promise<void>((resolve) => { (background ? waitingInBackground : waitingToLook).push(resolve) })
  }
  return () => {
    lookingNow -= 1
    if (background) backgroundNow -= 1
    dispatchLooks()
  }
}

/**
 * One look, never throwing, with no clock of its own.
 *
 * The shared scaffold behind every pass that looks at a file. The caller's
 * abort ends the request itself; a slow look is left to the silence clock in
 * the model client (`server/src/llm.ts`), which gives up on a connection that
 * stops sending bytes and nothing sooner (the per-pass deadlines — ninety to
 * three hundred seconds — were removed on 16/11/2026 at the user's request).
 * @param vision - the vision service.
 * @param path - absolute path of the file to look at.
 * @param instruction - what to ask of it.
 * @param route - the model to look with.
 * @param options - `maxSide` for the still, forwarded to the service;
 *   `also` for more pictures to look at in the same request (an edit with the
 *   picture it came from); `background` for a look nobody waits for, which
 *   runs in the capped lane; `signal` for a caller that may stop waiting (the
 *   look is then aborted, or never started when it was still queued for a slot).
 * @returns the reply, or undefined when the model failed or said nothing.
 */
export async function lookWith(
  vision: VisionCapable,
  path: string,
  instruction: string,
  route: ModelRoute,
  options?: { maxSide?: number; also?: readonly string[]; background?: boolean; signal?: AbortSignal },
): Promise<{ text: string; provider?: string; model?: string } | undefined> {
  const { background = false, signal, ...look } = options ?? {}
  const release = await lookSlot(background)
  if (signal?.aborted === true) {
    release()
    return undefined
  }
  const controller = new AbortController()
  const stop = (): void => { controller.abort() }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    const result = await vision.analyzeImage(path, instruction, { provider: route.provider, model: route.model }, {
      signal: controller.signal,
      ...look,
    })
    return result.text.trim().length === 0 ? undefined : result
  } catch (error: unknown) {
    /*
     * Silent until 2026-10-29: a vision model answering `403 Forbidden` (an
     * `auto/*` combo hidden on the gateway) made every identity read fail, the
     * run fell back to structural texts, and nothing in the journal said why —
     * every swap came back with the plate's face for a day.
     */
    console.warn(`[imagine] visione ${route.provider}/${route.model}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  } finally {
    release()
    signal?.removeEventListener('abort', stop)
  }
}
