/**
 * What the host hands the studio's server half (`tool-comfy`, `social`): the
 * ComfyUI client, the model clients, a route table and a place to register
 * cleanup. `main.ts` builds the one instance.
 *
 * It replaced the DSH plugin context (a cordis `Context` read as
 * `[key]: any`), so `ctx.llm` and the rest are typed at every use.
 * @module host
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ComfyUi } from '../vendor/comfyui/index.ts'
import type { StreamCapable, VisionCapable } from '../vendor/tool-comfy/imagine-models.ts'

/** One request handler of the host's route table. */
export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** A route: one exact path, or a prefix and everything under it. */
export interface WebRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: Handler
}

/** The host context. */
export interface ImagineHost {
  /** The ComfyUI client. */
  readonly comfy: ComfyUi
  /** The text model client (streamed chat completions). */
  readonly llm: StreamCapable
  /** The vision client. */
  readonly auxiliary: VisionCapable
  /**
   * Tell the owner something: every plugin that subscribed through
   * `ctx.onNotify` hears it. Never throws, never waits longer than a few
   * seconds per listener — a notice is an addition to an outcome, not part of it.
   */
  readonly notify: (text: string) => Promise<void>
  /**
   * Run `setup` now and keep the cleanup it returns for shutdown.
   * @param label - what the cleanup stops, for reading the code.
   */
  effect(setup: () => (() => void) | void, label?: string): void
  readonly webServer: {
    /** Add a route; the returned function removes it. */
    register(route: WebRoute): () => void
  }
}
