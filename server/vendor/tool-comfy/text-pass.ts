/**
 * One text pass tried on every route in turn, first usable answer wins.
 *
 * The studio's chip comes first, then Imagine's own text model, then the
 * harness's default: a model picked on the chip can be one that cannot answer
 * in the time a pass is worth waiting for, and stopping at it left the song,
 * the story or the look on the user's bare line. The story, music, title and
 * look passes each carried this loop (2026-10-21); the look stopped at the
 * first route.
 * @module tool-comfy/text-pass
 */

import type { ImagineHost } from '../../src/host.ts'
import { streamText, textRoutes, type StreamCapable } from './imagine-models.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'

/**
 * Ask every text route in order until one answer parses.
 *
 * Never throws. Reads the LLM off the host context (`ctx.llm`).
 * @param ctx - plugin context, carrying `llm` when set up.
 * @param chosen - the model the studio is showing, when the caller has one.
 * @param instruction - the prompt.
 * @param parse - turns a reply into the result, undefined when unusable.
 *
 * No clock of its own: every pass used to carry one (30 s for a project name,
 * 90 s for the story plan and a look, 120 s for a song's caption, 300 s for a
 * photo's parts), and each of them killed a model that was still working —
 * the story plan died at 90 s while the provider in `config.yaml` was allowed
 * 600 (2026-11-16). The only bound now is the silence clock in the model
 * client (`server/src/llm.ts`, `MODEL_SILENCE_MS`): a connection that stops
 * sending bytes is given up, a model that keeps sending tokens is not.
 * @returns the first usable result, or undefined when no route gave one.
 */
export async function firstTextReply<T>(
  ctx: ImagineHost,
  chosen: ModelRoute | undefined,
  instruction: string,
  parse: (written: string | undefined) => T | undefined,
  what: string,
): Promise<T | undefined> {
  const llm: StreamCapable | undefined = ctx.llm
  if (llm === undefined || typeof llm.stream !== 'function') {
    console.warn(`[imagine] ${what}: no text model on the context`)
    return undefined
  }
  // `textRoutes` already drops repeated routes: each one is a new attempt.
  const routes = textRoutes(chosen)
  for (const route of routes) {
    const key = `${route.provider}/${route.model}`
    const written = await streamText(llm, route, instruction)
    if (written === undefined || written.trim().length === 0) {
      console.warn(`[imagine] ${what}: ${key} did not answer`)
      continue
    }
    const result = parse(written)
    if (result !== undefined) return result
    /*
     * The discarded reply gets a line of its own. Every pass that uses this
     * helper falls back to something weaker on an unusable answer — the song
     * without its caption and without structure tags, the videoclip on the
     * bare request for every beat, the look on the catalogue's own text — and
     * until 2026-10-31 not one of them said so. A pass that loses its text is
     * only visible in the output, which is the worst place to find it.
     */
    console.warn(`[imagine] ${what}: answer from ${key} unusable (${String(written.trim().length)} characters), trying the next route`)
  }
  console.warn(`[imagine] ${what}: none of the ${String(routes.length)} routes wrote usable text`)
  return undefined
}
