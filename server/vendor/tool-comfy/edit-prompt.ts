/**
 * Vision pass that writes an Imagine edit's prompt from the source image.
 *
 * The studio's "Modifica" and "Cambia stile" buttons both post their text
 * straight into the Krea2 edit graph's prompt node. That sampler grounds the
 * instruction on the image it is given — `Krea2EditGroundedEncode` reads the
 * prompt and the picture together — so a preset line like "Redraw this image
 * as a Studio Ghibli anime frame" reaches it with nothing said about what is
 * actually in the frame, and a one-word request like "sfondo mare" says even
 * less. This runs the auxiliary vision model on the source and has it write
 * the grounded instruction around the user's intent.
 * @module tool-comfy/edit-prompt
 */

import type { ImagineHost } from '../../src/host.ts'
import { eyesOf } from './eyes.ts'
import { lookWith, secondVisionRoute } from './imagine-models.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'
import { isLocalEdit, LOCAL_EDIT_KEEP } from '../../../shared/imagine-edit.ts'
import { stripFences } from './model-json.ts'

// No fixed wait on the vision pass: see video-prompt.ts for why a bare line
// is worse than a slow one.

/** Shortest reply worth sending to the sampler instead of the user's line. */
const MIN_PROMPT_LENGTH = 24

/**
 * Longest reply accepted. A vision model that ignores the format answers with
 * an essay about the picture, and that essay would become the conditioning.
 */
const MAX_PROMPT_LENGTH = 1200

/**
 * Instructions for the vision model writing one edit's prompt.
 *
 * The user's line is the brief and is honoured literally: the model grounds it
 * on what the picture really contains — which subject, where, on what
 * background — rather than deciding on a different edit.
 * @param intent - the composer text the user typed, or the style preset.
 * @returns the instruction sent alongside the source image.
 */
function editPromptInstruction(intent: string): string {
  /*
   * A local edit is worded differently on purpose. The graph redraws the
   * whole photo, so a prompt that also describes the clothing, the body and
   * the background is read as a description of the scene and gets the scene
   * redrawn. Naming only the part to change, and closing with one fixed
   * sentence, is what keeps the rest out of the sampler's hands.
   */
  if (isLocalEdit(intent)) return localEditInstruction(intent)
  return `Look at this image: it is the starting image of an edit.

The user asked for: "${intent}"

Write the prompt for the image editing model that delivers EXACTLY that request. The user's request is binding: do not replace it and do not reinterpret it, anchor it to what the image really contains (which subject and where it is, background, light, framing).

Rules:
- Reply ONLY with the prompt, in English, in a single paragraph, with no preamble and no lists.
- Write an instruction ("Replace...", "Redraw...", "Change..."), not a description of the photo.
- Say explicitly what changes and on which element of the image, and close by saying what stays unchanged (identity and faces, pose, composition, background, light) among the parts the request does not touch.
- Carry the proper names and the quoted words of the request over unchanged: they switch the identity models on and would vanish if you rewrote them.
- Do not add changes the user did not ask for.`
}

/**
 * The instruction for a change to one part of a photo.
 *
 * Short by construction: the reply becomes the sampler's conditioning on a
 * graph that redraws everything, so every extra noun is something else to
 * redraw. The fixed final sentence is quoted so the vision pass ends with
 * the exact words the studio wants, whatever else it wrote.
 * @param intent - the user's line, or a template's wording.
 * @returns the instruction sent alongside the source image.
 */
function localEditInstruction(intent: string): string {
  return `Look at this image: it is the starting image of an edit that touches ONE part of it, and nothing else.

The user asked for: "${intent}"

Write the instruction for the image editing model that changes exactly that part.

Rules:
- Reply ONLY with the instruction, in English, one short sentence, with no preamble and no lists.
- Start with the verb ("Remove...", "Add...", "Replace...", "Move...") and name the one thing to change and where it is in the photo.
- Do NOT describe the rest of the photo: no clothing, no body, no pose, no background, no light, no framing. A list of what must stay is read as a description of the scene, and the whole scene gets redrawn.
- Do not add changes the user did not ask for.
- Carry the proper names and the quoted words of the request over unchanged: they switch the identity models on.
- End the instruction with exactly this sentence, copied word for word: "${LOCAL_EDIT_KEEP}"`
}

/**
 * Proper names the rewrite has to carry over.
 *
 * A rewrite must not rename what the request named: the prompt is what the
 * graph draws from, and dropping a proper name turns the run into a different
 * picture. Multi-word capitalised runs are the safe signal: they catch names
 * and style marks ("Studio Ghibli", "One Piece") without matching an ordinary
 * sentence opening.
 * @param intent - the user's line.
 * @returns the names that must survive, lowercased for comparison.
 */
function anchorsOf(intent: string): string[] {
  return [...intent.matchAll(/\p{Lu}\p{L}+(?:\s+\p{Lu}\p{L}+)+/gu)].map(match => match[0].toLowerCase())
}

/**
 * Keep only the prompt body when the model wraps it in prose or a fence.
 *
 * A small vision model answers the format instruction well but still likes a
 * "Ecco il prompt:" preamble or a ```` ``` ```` fence, and both would be fed
 * to the sampler as part of the conditioning.
 * @param text - the raw model reply.
 * @param intent - the user's line, whose proper names must survive the rewrite.
 * @returns the prompt body, or the reason it was refused.
 */
function cleanEditPrompt(text: string, intent: string): EditPromptRead {
  const unfenced = stripFences(text)
  // A preamble is its own short line ending in a colon; a colon inside the
  // prompt itself ("style: soft cel shading") sits mid-line and is kept.
  const body = unfenced.replaceAll(/^[^\n:]{0,80}:[ \t]*\n/gm, '').replaceAll(/\s*\n\s*/g, ' ').trim()
  // A local edit is allowed to be one short sentence: "Remove the extra arm"
  // is a complete instruction, and the fixed keep sentence is added later.
  const shortest = isLocalEdit(intent) ? 8 : MIN_PROMPT_LENGTH
  if (body.length < shortest) return { refused: `too short (${String(body.length)} characters)` }
  if (body.length > MAX_PROMPT_LENGTH) return { refused: `too long (${String(body.length)} characters)` }
  const lowered = body.toLowerCase()
  const missing = anchorsOf(intent).find(anchor => !lowered.includes(anchor))
  return missing === undefined ? { prompt: body } : { refused: `it does not name "${missing}"` }
}

/** The written edit prompt, or the reason the reply could not be used. */
type EditPromptRead = { readonly prompt: string } | { readonly refused: string }

/**
 * Write an edit's grounded prompt from its source image and the user's intent.
 *
 * Never throws: no model to look with, a slow model or a reply in the
 * wrong shape all fall back to the user's own text, because losing the edit
 * would be worse than sending a prompt that is merely ungrounded.
 * @param ctx - the host context, which may carry the auxiliary service.
 * @param imagePath - absolute path of the image being edited.
 * @param intent - the composer text the user typed, or the style preset.
 * @param chosen - the model the chip showed when the job started.
 * @returns the written prompt, or undefined to keep the raw one.
 */
export async function writeEditPrompt(
  ctx: ImagineHost,
  imagePath: string,
  intent: string,
  chosen?: ModelRoute,
): Promise<string | undefined> {
  // The chip's model: the eyes are the ones the user picked.
  const eyes = eyesOf(ctx, chosen)
  if (eyes === undefined) {
    console.warn('[imagine] edit prompt: no model to look at the image, using the user\'s line')
    return undefined
  }
  /*
   * The second vision route as well:
   * a chip model that cannot answer in the time an edit is worth waiting for
   * used to send four words to `Krea2EditGroundedEncode`, which grounds on
   * nothing and redraws from the raw line. Every refusal is said out loud,
   * because a discarded reply is invisible in the picture except as "it did
   * not do what I asked".
   */
  // `secondVisionRoute` is, by construction, a route other than the first.
  const second = secondVisionRoute(chosen)
  const routes = second === undefined ? [eyes.route] : [eyes.route, second]
  for (const route of routes) {
    const key = `${route.provider}/${route.model}`
    const result = await lookWith(eyes.vision, imagePath, editPromptInstruction(intent), route)
    if (result === undefined) {
      console.warn(`[imagine] edit prompt: ${key} did not answer`)
      continue
    }
    const read = cleanEditPrompt(result.text, intent)
    if ('refused' in read) {
      console.warn(`[imagine] edit prompt: answer from ${key} discarded, ${read.refused}`)
      continue
    }
    return read.prompt
  }
  console.warn(`[imagine] edit prompt: none of the ${String(routes.length)} routes wrote a usable prompt, using the user's line`)
  return undefined
}
