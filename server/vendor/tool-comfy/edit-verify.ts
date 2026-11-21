/**
 * The vision pass that checks an edit against its source and its own spec.
 *
 * The agent used to say an edit was done without ever comparing it with the
 * original: on 2026-11-21 the reply denied that some lettering had been
 * removed while nothing had been checked, and another reply called "more
 * sensual" done while the result carried nudity nobody asked for. A check is
 * not a description: it sees the source and the result together, it is given
 * the spec the run was built from, and it answers a closed JSON object, so the
 * reply can be built on facts instead of on what the model remembers.
 *
 * Tolerant on quality (a different light, a softer texture, a sharper
 * rendering), strict on adherence: the change, the preserved items, anything
 * unrequested, and the writing that was there and is gone.
 * @module tool-comfy/edit-verify
 */

import { join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { eyesOf } from './eyes.ts'
import { lookWith } from './imagine-models.ts'
import { jsonObjectOf } from './model-json.ts'
import { samePicture } from './media-tools.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'
import { languageName } from '../../../shared/locale-names.ts'
import type { EditSpec, PreserveItem } from './edit-spec.ts'

/** What the comparison found: the verdict the reply is held to. */
export interface EditVerdict {
  /** Whether the change the user asked for is visible in the result. */
  readonly requestedChangeDone?: boolean
  /** One answer per item the spec had to keep. */
  readonly preservedOk: Readonly<Partial<Record<PreserveItem, boolean>>>
  /** Written text read literally in the result. */
  readonly textFound: readonly string[]
  /** What the result shows that the user did not ask for. */
  readonly unrequestedChanges: readonly string[]
  /** True when the result is the source picture, near enough (measured, not asked). */
  readonly identicalToSource: boolean
  /** What the source had and the result lost. */
  readonly missing: readonly string[]
  /** The pass's own literal sentence about the result. */
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
function verdictInstruction(input: {
  readonly source: string
  readonly result: string
  readonly spec: EditSpec
  readonly language: string
}): string {
  const preserve = input.spec.preserve.length === 0
    ? 'The source is a picture; keep nothing else in mind.'
    : `What had to stay: ${input.spec.preserve.join(', ')}.`
  const shape = input.spec.preserve.includes('format')
    ? 'A different frame shape is a fault here.'
    : 'A new frame shape may be what was asked.'
  return `The FIRST picture is the SOURCE (${input.source}). The SECOND picture is the RESULT of an edit (${input.result}).

The user asked: "${input.spec.change}"
${preserve}
${input.spec.intensity === 'one-step' ? 'The line asked for one step more of something, not for a new picture.' : ''}

Answer with ONE JSON object and no other text, in ${input.language}:
{"requested_change_done": true|false,
 "preserved_ok": {${input.spec.preserve.map(item => `"${item}": true|false`).join(', ')}},
 "text_found": ["..."],
 "unrequested_changes": ["..."],
 "identical_to_source": true|false,
 "missing": ["..."],
 "description": "..."}

Rules:
- requested_change_done: true only when the user's change is visible; false when it is not.
- preserved_ok: one answer per item listed above (framing, text, subjects, style, format). "text" means the written text the source had is still there and reads the same.
- text_found: the written text you can read in the RESULT, quoted exactly; [] when there is none.
- unrequested_changes: what the result shows that the user did not ask for: another subject, a new object, a different setting, a different frame, nudity or more explicit content than the source. ${shape}
- identical_to_source: true when the result is the source picture, unchanged.
- missing: what the source had and the result no longer has, especially written text and symbols; quote written text exactly.
- description: one literal sentence about what the result shows; no estimates, no dimensions.
Judge only what is clearly visible. Be tolerant on quality (a different light, a softer texture, a sharper rendering are not faults) and strict on adherence (the change, the preserved items, lost text, anything unrequested).`
}

/**
 * Check one edited picture against its source and the spec it was run from.
 *
 * @param deps - the turn's host, folder and model.
 * @param source - the source picture's gallery name.
 * @param result - the result picture's gallery name.
 * @param spec - what the run was asked to change and to keep.
 * @returns the verdict, or undefined when there is no vision model mounted or
 *   the pass did not answer.
 */
export async function verifyEdit(
  deps: EditCheckDeps,
  source: string,
  result: string,
  spec: EditSpec,
): Promise<EditVerdict | undefined> {
  const eyes = eyesOf(deps.ctx, deps.model)
  if (eyes === undefined) return undefined
  const sourcePath = join(deps.outputDir, source)
  const resultPath = join(deps.outputDir, result)
  const seen = await lookWith(eyes.vision, sourcePath, verdictInstruction({
    source,
    result,
    spec,
    language: languageName(deps.language),
  }), eyes.route, {
    maxSide: 1024,
    also: [resultPath],
    ...deps.signal === undefined ? {} : { signal: deps.signal },
  })
  if (seen === undefined) return undefined
  const answer = jsonObjectOf(seen.text)
  if (answer === undefined) return undefined
  // The bytes decide whether the picture changed: no model is asked that.
  const identicalToSource = await samePicture(sourcePath, resultPath).catch(() => false)
  const raw = typeof answer['preserved_ok'] === 'object' && answer['preserved_ok'] !== null
    ? answer['preserved_ok'] as Record<string, unknown>
    : {}
  const preservedOk: Partial<Record<PreserveItem, boolean>> = {}
  for (const item of spec.preserve) {
    if (typeof raw[item] === 'boolean') preservedOk[item] = raw[item] as boolean
  }
  return {
    // A picture that did not change did not deliver a change, whatever the pass wrote.
    requestedChangeDone: identicalToSource ? false : typeof answer['requested_change_done'] === 'boolean' ? answer['requested_change_done'] : undefined,
    preservedOk,
    textFound: strings(answer['text_found']),
    unrequestedChanges: strings(answer['unrequested_changes']),
    identicalToSource,
    missing: strings(answer['missing']),
    ...typeof answer['description'] === 'string' && answer['description'].trim().length > 0
      ? { description: answer['description'].replace(/\s+/g, ' ').trim() }
      : {},
  }
}
