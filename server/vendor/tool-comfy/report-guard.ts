/**
 * What a reply has to carry, from the checks that actually ran.
 *
 * The model writes the reply from memory: on 2026-11-21 it denied nudity that
 * the result carried and denied losing lettering it had never compared. The
 * loop keeps what the checks found (a `look`'s own sentence, a comparison of
 * an edit with its source) and appends the facts the reply left out, so the
 * report reflects the pass even when the model contradicts it.
 *
 * The guard is a floor, not a censor: it adds a sentence a check supports and
 * never removes one the model wrote. A reply that already says the fact keeps
 * its own words.
 * @module tool-comfy/report-guard
 */

import { message } from '../../src/messages.ts'
import type { EditCheck } from './edit-verify.ts'
import { deniesExplicitness, explicitLabels } from './explicitness.ts'

/** One file a `look` was taken of, with the pass's sentence. */
export interface LookFact {
  readonly file: string
  readonly seen: string
}

/** One edited file with the comparison against its source. */
export interface EditFact {
  readonly file: string
  readonly check: EditCheck
}

/** Everything the guard reads about a turn. */
export interface ReportInput {
  /** The user's line: what was actually asked for. */
  readonly asked: string
  readonly looks: readonly LookFact[]
  readonly edits: readonly EditFact[]
  /** The reply the model wrote, before the guard. */
  readonly reply: string
}

/** The words of a description, lowercased, without the very short ones. */
function keywords(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word.length >= 4)
}

/**
 * Whether a reply already says one finding.
 *
 * Lenient on purpose: when one meaningful word of the finding is in the reply,
 * the model has addressed it, and a sentence about the same thing in its own
 * words is what the user should read.
 * @param reply - the written reply.
 * @param finding - what a check reported.
 * @returns true when the reply carries at least one meaningful word of it.
 */
function mentions(reply: string, finding: string): boolean {
  const words = new Set(keywords(reply))
  return keywords(finding).some(word => words.has(word))
}

/** Whether a reply says the result is the source picture. */
function saysUnchanged(reply: string): boolean {
  return /\b(identic[oa]|stess[oa]|invariat[oa]|nessun cambiamento|non è cambiata|non e cambiata|unchanged|identical|the same|no change)\b/i.test(reply)
}

/**
 * The sentences a reply left out, in the interface's language.
 * @param input - the turn's checks and the reply.
 * @returns one sentence per fact the reply has to carry, empty when it already does.
 */
export function reportGaps(input: ReportInput): readonly string[] {
  const gaps: string[] = []
  for (const edit of input.edits) {
    const check = edit.check
    if (check.same && !saysUnchanged(input.reply)) gaps.push(message('agent.checkSame', { file: edit.file }))
    const lost = check.missing.filter(item => !mentions(input.reply, item))
    if (lost.length > 0) gaps.push(message('agent.checkLost', { file: edit.file, items: lost.join(', ') }))
    const extra = check.added.filter(item => !mentions(input.reply, item))
    if (extra.length > 0) gaps.push(message('agent.checkAdded', { file: edit.file, items: extra.join(', ') }))
  }
  const allowed = new Set(explicitLabels(input.asked))
  for (const look of input.looks) {
    const unasked = explicitLabels(look.seen).filter(label => !allowed.has(label))
    if (unasked.length === 0) continue
    const said = explicitLabels(input.reply)
    // A denial is the contradiction the guard exists for: "non l'ho fatta
    // nuda" while the pass describes nudity is not an acknowledgement.
    if (said.length > 0 && !deniesExplicitness(input.reply)) continue
    gaps.push(message('agent.visionExplicit', { file: look.file, seen: look.seen }))
  }
  return gaps
}

/**
 * The reply with the facts it left out appended as their own paragraph.
 * @param reply - what the model wrote.
 * @param gaps - the sentences {@link reportGaps} returned.
 * @returns the reply, unchanged when there is no gap.
 */
export function withGaps(reply: string, gaps: readonly string[]): string {
  if (gaps.length === 0) return reply
  const body = reply.trim()
  return body.length === 0 ? gaps.join(' ') : `${body}\n\n${gaps.join(' ')}`
}
