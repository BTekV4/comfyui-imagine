/**
 * What a run actually produced, judged against the spec it carried.
 *
 * The reply is written by the model, and a model that did not look at the
 * result describes what it meant to do (2026-11-21: it denied nudity it had
 * just described, and denied a loss it never checked). So the check is a look
 * of its own: source and result side by side, the spec in the question, one
 * JSON answer with the change, the kept things and the written text — and the
 * verdict is what the reply has to be built from.
 *
 * The verdict is deliberately tolerant about quality (light, texture, detail)
 * and strict about adherence (the change done, the kept things kept, the text
 * read). A result that is the source again is a failure, whichever way it is
 * described, and so is a result that repeats an earlier attempt.
 * @module tool-comfy/edit-verify
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'
import type { ImagineChatEvent } from '../../../shared/imagine-chat.ts'
import { languageName } from '../../../shared/locale-names.ts'
import { eyesOf } from './eyes.ts'
import { ffmpegTo, samePicture } from './media-tools.ts'
import { lookWith } from './imagine-models.ts'
import type { EditSpec, PreserveKey } from './edit-spec.ts'

/** How a run came out, in the one word the reply has to carry. */
export type VerdictState = 'completed' | 'partial' | 'failed'

/** What the look found, with the checks the code made itself. */
export interface Verdict {
  readonly state: VerdictState
  /** Whether the change the user asked for is in the picture. */
  readonly requested_change_done: boolean
  /** One entry per thing the spec said to keep. */
  readonly preserved_ok: Readonly<Partial<Record<PreserveKey, boolean>>>
  /** Every legible piece of written text, quoted as it reads. */
  readonly text_found: readonly string[]
  /** What changed besides the request. */
  readonly unrequested_changes: readonly string[]
  /** Whether the result is the source again (measured, not judged). */
  readonly identical_to_source: boolean
  /** The earlier result this one repeats, when it does (measured). */
  readonly repeated?: string
  /** The look's own description, in the studio's language. */
  readonly description: string
}

/** What the verdict is about. */
export interface VerifyRequest {
  /** The result's gallery name. */
  readonly file: string
  /** The picture it was made from, for an edit. */
  readonly source?: string
  /** The spec the run carried. */
  readonly spec: EditSpec
  /** The prompt that was drawn, so the look knows the words in play. */
  readonly prompt?: string
  /** The interface's language, for the description. */
  readonly language?: string
  /** Earlier results of the same request, to catch a repeat. */
  readonly previous?: readonly string[]
}

/** What one verification needs from the turn. */
export interface VerifyDeps {
  readonly ctx: ImagineHost
  readonly outputDir: string
  readonly model?: ModelRoute
  readonly language?: string
  readonly signal?: AbortSignal
  /** One line for the page, when the turn shows steps. */
  readonly say?: (event: ImagineChatEvent) => void
}

/** The instruction that asks for the one JSON answer. */
export function verifyInstruction(request: VerifyRequest): string {
  const halves = request.source === undefined
    ? 'Look at this picture, made from the prompt below.'
    : 'Look at this image: it is two pictures side by side, the LEFT half is the ORIGINAL, the RIGHT half is the RESULT of an edit.'
  const keeps = request.spec.preserve.length === 0
    ? 'nothing was declared as kept'
    : request.spec.preserve.map(key => `${key} ("${keepWords(key)}")`).join(', ')
  const textRule = request.spec.preserve.includes('text')
    ? 'The text was declared as kept: read every legible piece of written text in the result, quoted exactly as it reads, and say if one of the original\'s words is gone or changed.'
    : 'Read every legible piece of written text in the result, quoted exactly as it reads.'
  return [
    halves,
    request.prompt === undefined ? '' : `The words drawn: "${request.prompt}".`,
    `The change asked for: "${request.spec.change}".${request.spec.intensity === undefined ? '' : ` Go no further than this: "${request.spec.intensity}".`}`,
    `Declared to keep: ${keeps}.`,
    'Answer with ONE JSON object and nothing else, exactly these keys:',
    '{"description": "...", "requested_change_done": true, "preserved_ok": {"format": true}, "text_found": ["..."], "unrequested_changes": ["..."]}',
    `- description: one literal sentence in ${languageName(request.language)} about what the RESULT shows (the subject, the setting, the main colours, how the frame is composed). Do not estimate sizes or counts.`,
    '- requested_change_done: true only when the result shows the change asked for, not something close to it.',
    `- preserved_ok: one entry per declared item (${request.spec.preserve.join(', ') || 'none'}), true only when it is visibly unchanged.`,
    `- text_found: ${textRule} An empty list when there is none.`,
    '- unrequested_changes: what changed besides the asked change (a different subject posed, clothes off that were on, an object gone, the framing or the palette moved). An empty list when there is none. Be tolerant about light, texture and detail; be strict about the subject, the clothes, the framing, the format and the text.',
  ].filter(line => line !== '').join('\n')
}

/** The owner's word for what each kept key means, for the instruction. */
function keepWords(key: PreserveKey): string {
  switch (key) {
    case 'format': return 'the same frame shape and size'
    case 'framing': return 'the same framing and pose, nothing moved in or out of frame'
    case 'text': return 'the written text, word for word'
    case 'subjects': return 'the same subjects, nothing added and nothing taken away'
    case 'style': return 'the same medium and style'
  }
}

/** One of the look's answers, as it was written. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/** The strings of an array answer, cleaned. */
function asList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(asText).filter(text => text !== '')
}

/**
 * The JSON the look wrote, out of an answer that may carry a sentence around it.
 * @param raw - the model's text.
 * @returns the object, or undefined when there is none.
 */
export function parseVerdictJson(raw: string): Record<string, unknown> | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The verdict of one look, with what the code measured folded in.
 *
 * A result that is the source again fails whatever the look said about the
 * change; an unmet item the look declared is a loss even when everything else
 * went well.
 * @param answer - the parsed JSON.
 * @param spec - the run's spec.
 * @param measured - what the code measured on the pixels.
 * @returns the verdict.
 */
export function verdictOf(
  answer: Record<string, unknown>,
  spec: EditSpec,
  measured: { readonly identical_to_source: boolean; readonly repeated?: string },
): Verdict {
  const requested = answer['requested_change_done'] === true && !measured.identical_to_source
  const preserved: Partial<Record<PreserveKey, boolean>> = {}
  const rawPreserved = typeof answer['preserved_ok'] === 'object' && answer['preserved_ok'] !== null
    ? answer['preserved_ok'] as Record<string, unknown>
    : {}
  for (const key of spec.preserve) preserved[key] = rawPreserved[key] !== false
  const lost = Object.values(preserved).some(ok => ok === false)
  const unrequested = asList(answer['unrequested_changes'])
  const repeated = measured.repeated !== undefined
  const state: VerdictState = !requested || repeated
    ? 'failed'
    : lost || unrequested.length > 0 ? 'partial' : 'completed'
  return {
    state,
    requested_change_done: requested,
    preserved_ok: preserved,
    text_found: asList(answer['text_found']),
    unrequested_changes: unrequested,
    identical_to_source: measured.identical_to_source,
    ...measured.repeated === undefined ? {} : { repeated: measured.repeated },
    description: asText(answer['description']),
  }
}

/** Where one half of the pair sits, in pixels. */
const PAIR_SIDE = 760

/**
 * The two pictures as one image, original on the left: one vision call sees
 * both, which is the only way a comparison can be asked for honestly.
 * @param source - absolute path of the original.
 * @param result - absolute path of the result.
 * @param out - absolute path of the pair image to write.
 * @returns the path written.
 */
async function pairImage(source: string, result: string, out: string): Promise<string> {
  const fit = (index: number): string => `[${String(index)}:v]scale=${String(PAIR_SIDE)}:${String(PAIR_SIDE)}:force_original_aspect_ratio=decrease,pad=${String(PAIR_SIDE)}:${String(PAIR_SIDE)}:(ow-iw)/2:(oh-ih)/2:white[s${String(index)}]`
  return await ffmpegTo(out, [
    '-v', 'error', '-y', '-i', source, '-i', result,
    '-filter_complex', `${fit(0)};${fit(1)};[s0][s1]hstack=inputs=2`,
    '-frames:v', '1',
  ], 60_000)
}

/**
 * Look at a result against its spec, and say what it came to.
 *
 * One call: the two halves of an edit (or the result alone), the spec, and the
 * JSON answer the instruction asks for. The measures the code can take itself
 * — is this the source again, does it repeat an earlier result — are taken
 * here, so no answer can talk its way past them.
 * @param deps - the turn's host, media folder, route and language.
 * @param request - what to verify.
 * @returns the verdict, or the reason it could not be made.
 */
export async function verifyRun(deps: VerifyDeps, request: VerifyRequest): Promise<{ readonly verdict: Verdict } | { readonly error: string }> {
  const eyes = eyesOf(deps.ctx, deps.model)
  if (eyes === undefined) return { error: 'no vision model is configured on this studio' }
  const resultPath = join(deps.outputDir, request.file)
  if (!existsSync(resultPath)) return { error: `${request.file} is not in the media folder` }
  const sourcePath = request.source === undefined ? undefined : join(deps.outputDir, request.source)
  if (sourcePath !== undefined && !existsSync(sourcePath)) return { error: `${request.source ?? ''} is not in the media folder` }
  const identical = sourcePath === undefined ? false : await samePicture(sourcePath, resultPath)
  let repeated: string | undefined
  for (const earlier of request.previous ?? []) {
    if (earlier === request.file) continue
    const path = join(deps.outputDir, earlier)
    if (!existsSync(path)) continue
    if (await samePicture(path, resultPath)) { repeated = earlier; break }
  }
  const scratch = await mkdtemp(join(tmpdir(), 'imagine-verify-'))
  try {
    const look = sourcePath === undefined
      ? resultPath
      : await pairImage(sourcePath, resultPath, join(scratch, 'pair.png'))
    deps.say?.({ kind: 'step', step: 'sight', detail: request.file })
    const seen = await lookWith(eyes.vision, look, verifyInstruction(request), eyes.route, {
      ...deps.signal === undefined ? {} : { signal: deps.signal },
      maxSide: 1400,
    })
    if (seen === undefined) return { error: 'the vision model did not answer' }
    const answer = parseVerdictJson(seen.text)
    if (answer === undefined) return { error: `the vision model did not answer with the JSON the check asks for: ${seen.text.slice(0, 200)}` }
    return { verdict: verdictOf(answer, request.spec, { identical_to_source: identical, ...repeated === undefined ? {} : { repeated } }) }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** The state words a reply may carry, per language of the interface. */
const STATE_WORDS: Readonly<Record<VerdictState, readonly string[]>> = {
  completed: ['completat', 'completed', 'complete'],
  partial: ['parzial', 'partial'],
  failed: ['fallit', 'failed', 'non riuscit'],
}

/**
 * Whether a reply says how the work came out.
 *
 * The reply is told to open with one of three states; a reply that names a
 * different state from the verdict, or none, is asked for once more.
 * @param reply - the text the model wrote.
 * @param verdict - what the check found.
 * @returns true when the reply must be rewritten.
 */
export function verdictNeedsState(reply: string, verdict: Verdict | undefined): boolean {
  if (verdict === undefined) return false
  const text = reply.toLowerCase()
  const says = (state: VerdictState): boolean => STATE_WORDS[state].some(word => text.includes(word))
  if (!says(verdict.state)) return true
  // A "failed" reply that also claims it worked is the contradiction to avoid.
  return (Object.keys(STATE_WORDS) as VerdictState[]).some(state => state !== verdict.state && says(state))
}

/**
 * The one message that asks for the reply again, with the verdict's own word.
 * @param verdict - what the check found.
 * @returns the instruction to append after the reply.
 */
export function stateRewriteAsk(verdict: Verdict): string {
  const lost = Object.entries(verdict.preserved_ok).filter(([, ok]) => ok === false).map(([key]) => key)
  const facts = [
    `state: ${verdict.state}`,
    `description: ${verdict.description}`,
    ...verdict.text_found.length === 0 ? [] : [`text read: ${verdict.text_found.join(' | ')}`],
    ...lost.length === 0 ? [] : [`lost: ${lost.join(', ')}`],
    ...verdict.unrequested_changes.length === 0 ? [] : [`not asked for: ${verdict.unrequested_changes.join('; ')}`],
    ...verdict.identical_to_source ? ['the result is the original again'] : [],
    ...verdict.repeated === undefined ? [] : [`the result repeats ${verdict.repeated}`],
  ]
  return `Rewrite your last reply so that it says how the work came out. The check on the result found: ${facts.join('; ').replace(/\.+$/, '')}. ` +
    `Open with the word for "${verdict.state}" and keep only what that check found: do not deny a loss it names, do not claim done when it is ${verdict.state}. ` +
    'Keep the same facts and file names; add nothing, remove nothing, and do not call a tool. Answer with the rewritten text alone.'
}
