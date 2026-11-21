/**
 * The vision pass that checks an edit against the picture it came from.
 *
 * The agent used to say an edit was done without ever comparing it with the
 * original: on 2026-11-21 the reply denied that some lettering had been
 * removed while nothing had been checked, and another reply called "more
 * sensual" done while the result carried nudity nobody asked for. A check is
 * not a description: it needs the source, the result and the request, and it
 * answers a closed JSON object, so the reply can be built on facts instead of
 * on what the model remembers.
 *
 * The pass is deliberately simple to satisfy and strict to contradict: a
 * different light or a softer texture is not a fault, an element the source
 * had and the result lost is.
 * @module tool-comfy/edit-verify
 */

import { join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { eyesOf } from './eyes.ts'
import { lookWith } from './imagine-models.ts'
import { jsonObjectOf } from './model-json.ts'
import { samePicture } from './media-tools.ts'
import { recallNotes } from './imagine-notes.ts'
import { sightInMemory } from './imagine-sight.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'
import { languageName } from '../../../shared/locale-names.ts'

/** What a comparison of one edit with its source found. */
export interface EditCheck {
  /** Whether the change the user asked for is visible in the result. */
  readonly changeDone?: boolean
  /** What the source had and the result no longer has, in the pass's words. */
  readonly missing: readonly string[]
  /** What the result shows that the user did not ask for. */
  readonly added: readonly string[]
  /** Written text read literally in the result. */
  readonly text: readonly string[]
  /** True when the result is the source picture, near enough. */
  readonly same: boolean
  /** The pass's own sentence about the result, when it wrote one. */
  readonly description?: string
}

/** What a check needs from the turn. */
export interface EditCheckDeps {
  readonly ctx: ImagineHost
  readonly outputDir: string
  readonly model?: ModelRoute
  readonly language?: string
  readonly signal?: AbortSignal
}

/** The strings of an array-shaped field, when the model wrote one. */
function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.replace(/\s+/g, ' ').trim())
    .filter(entry => entry.length > 0)
    .slice(0, 20)
}

/** The instruction the comparison answers. */
function checkInstruction(input: {
  readonly asked: string
  readonly sourceSight?: string
  readonly language: string
}): string {
  const source = input.sourceSight === undefined || input.sourceSight.trim().length === 0
    ? 'The source was not described beforehand.'
    : `The picture it was made from was described as: "${input.sourceSight.trim()}"`
  return `Look at this image: it is the RESULT of editing another picture.

The user asked for: "${input.asked}"
${source}

Answer with ONE JSON object and no other text, in ${input.language}:
{"requested_change_done": true|false, "missing": ["..."], "added": ["..."], "text": ["..."], "description": "..."}

Rules:
- requested_change_done: true only when the user's change is visible; false when it is not.
- missing: what the source had and this result no longer has, especially written text and symbols; quote written text exactly as it reads.
- added: what this result shows that the user did not ask for: another subject, a new object, a different setting, a different frame, nudity or more explicit content than the source.
- text: the written text you can read in this result, quoted exactly; [] when there is none.
- description: one literal sentence about what this result shows; no estimates, no dimensions.
Judge only what is clearly visible. A changed light, a softer texture or a sharper rendering is not a fault and does not belong in "missing" or "added".`
}

/**
 * Check one edited picture against its source.
 *
 * @param deps - the turn's host, folder and model.
 * @param source - the source picture's gallery name.
 * @param result - the result picture's gallery name.
 * @param asked - the user's line, which is what the edit had to deliver.
 * @returns the check, or undefined when there is no vision model mounted or
 *   the pass did not answer.
 */
export async function checkEdit(
  deps: EditCheckDeps,
  source: string,
  result: string,
  asked: string,
): Promise<EditCheck | undefined> {
  const eyes = eyesOf(deps.ctx, deps.model)
  if (eyes === undefined) return undefined
  const language = languageName(deps.language)
  const sourceSight = (await recallNotes([source]).catch(() => new Map())).get(source)?.sight ?? sightInMemory(source)
  const seen = await lookWith(eyes.vision, join(deps.outputDir, result), checkInstruction({
    asked,
    ...sourceSight === undefined ? {} : { sourceSight },
    language,
  }), eyes.route, {
    maxSide: 1024,
    ...deps.signal === undefined ? {} : { signal: deps.signal },
  })
  if (seen === undefined) return undefined
  const answer = jsonObjectOf(seen.text)
  if (answer === undefined) return undefined
  return {
    ...typeof answer['requested_change_done'] === 'boolean' ? { changeDone: answer['requested_change_done'] } : {},
    missing: strings(answer['missing']),
    added: strings(answer['added']),
    text: strings(answer['text']),
    same: await samePicture(join(deps.outputDir, source), join(deps.outputDir, result)).catch(() => false),
    ...typeof answer['description'] === 'string' && answer['description'].trim().length > 0
      ? { description: answer['description'].replace(/\s+/g, ' ').trim() }
      : {},
  }
}
