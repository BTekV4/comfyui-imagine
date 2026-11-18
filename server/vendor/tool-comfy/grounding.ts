/**
 * Find one thing inside a photo, for the written lane.
 *
 * The chat decides that something has to change or come out, and names it in
 * the photo's own words; this pass points at it. One vision call with the
 * picture, the name and (when it exists) the description already filed for
 * the file, so the model can match "la borsa" to "the red handbag" before it
 * draws a box.
 *
 * Never throws and never waits forever: no vision model, a slow one or a
 * reply without a box all answer undefined, and the caller says so.
 * @module tool-comfy/grounding
 */

import { join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { eyesOf } from './eyes.ts'
import { lookWith } from './imagine-models.ts'
import { kindOf, safeBasename } from './gallery.ts'
import { groundingInstruction, parseGrounding, type GroundingAsk } from '../../../shared/imagine-grounding.ts'
import type { ImagineRegion, ModelRoute } from '../../../shared/imagine-types.ts'

/**
 * The box around what the line named, as fractions of the photo.
 * @param ctx - the host, for the vision service.
 * @param outputDir - the gallery folder.
 * @param name - the photo's basename, already in the gallery.
 * @param ask - what the user named, and what the photo contains.
 * @param chosen - the model the composer's chip showed, when known.
 * @param signal - stops the look when the chat closes.
 * @returns the box, or undefined when the photo does not contain it.
 */
export async function groundTarget(
  ctx: ImagineHost,
  outputDir: string,
  name: string,
  ask: GroundingAsk,
  chosen?: ModelRoute,
  signal?: AbortSignal,
): Promise<ImagineRegion | undefined> {
  const safe = safeBasename(name)
  if (safe === undefined || kindOf(safe) !== 'image') return undefined
  const eyes = eyesOf(ctx, chosen)
  if (eyes === undefined) return undefined
  const reply = await lookWith(eyes.vision, join(outputDir, safe), groundingInstruction(ask), eyes.route, {
    ...signal === undefined ? {} : { signal },
  })
  return parseGrounding(reply?.text)
}
