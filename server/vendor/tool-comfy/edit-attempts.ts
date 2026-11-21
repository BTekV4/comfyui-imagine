/**
 * What was tried on one picture, what it came to, and when to stop.
 *
 * The agent could queue the same edit again and again with the same words:
 * measured on 2026-11-21, the same request was run twice and the second result
 * was the same picture, reported as a new success. An attempt is recorded with
 * its signature (the arguments that decide the picture) and its verdict. The
 * same signature cannot be run twice after it failed, three attempts on one
 * picture are the limit, and the final report is built from the verdicts
 * rather than from the model's memory.
 * @module tool-comfy/edit-attempts
 */

import { message } from '../../src/messages.ts'
import type { EditVerdict } from './edit-verify.ts'
import type { PreserveItem } from './edit-spec.ts'

/** How many attempts one picture gets before the turn stops. */
export const MAX_ATTEMPTS = 3

/** One run on one picture, as it was asked and as it came out. */
export interface EditAttempt {
  /** The source picture's name, or the card id the run started from. */
  readonly target: string
  /** The arguments that decide the picture, stable across a retry. */
  readonly signature: string
  /** The change the run was asked for, in the user's words. */
  readonly change: string
  /** The result, once the run settled. */
  readonly file?: string
  /** What the comparison found, when the vision pass could compare. */
  readonly verdict?: EditVerdict
  /** The run's own error, when it did not settle. */
  readonly error?: string
}

/**
 * The signal of one call: its tool, its words, and the arguments a retry would
 * repeat. Two calls with the same signature make the same picture.
 * @param name - the tool's name.
 * @param args - its parsed arguments.
 * @returns a stable string.
 */
export function signatureOf(name: string, args: Readonly<Record<string, unknown>>): string {
  const kept: Record<string, unknown> = { tool: name }
  for (const key of ['prompt', 'source', 'target', 'region', 'aspect', 'resolution', 'count', 'reference', 'customWorkflowId', 'customFields', 'customFiles', 'extras'] as const) {
    if (args[key] !== undefined) kept[key] = args[key]
  }
  return Object.keys(kept)
    .sort()
    .map(key => `${key}=${JSON.stringify(kept[key])}`)
    .join('&')
}

/**
 * Whether a verdict describes a fault in one element while the rest is intact.
 *
 * A lost text or an object nobody asked for is a local correction: the photo
 * does not have to be redrawn whole, and a retry that names no zone would.
 * @param verdict - what the check found.
 * @returns true when the fix is local.
 */
export function localizedDefect(verdict: EditVerdict): boolean {
  if (verdict.identicalToSource) return false
  if (Object.values(verdict.preservedOk).some(ok => ok === false)) return false
  return verdict.missing.length > 0 || verdict.unrequestedChanges.length > 0
}

/** Whether a verdict says the attempt did not deliver what was asked. */
export function verdictFailed(verdict: EditVerdict): boolean {
  if (verdict.identicalToSource) return true
  if (verdict.requestedChangeDone === false) return true
  if (verdict.unrequestedChanges.length > 0) return true
  return Object.values(verdict.preservedOk).some(ok => ok === false)
}

/**
 * Why the next call on a picture may not run, when it may not.
 *
 * Two rules, both from the same fault: a failed combination is not run again
 * unchanged (the second result was the same picture, reported as a success),
 * and a picture gets three attempts and no more.
 * @param attempts - what the turn has tried.
 * @param target - the picture the call is about.
 * @param signature - the signal of the call about to run.
 * @param history - signatures that already failed on this picture in an
 *   earlier turn, read from its filed state.
 * @returns the refusal, or undefined when the call may run.
 */
export function attemptRefusal(
  attempts: readonly EditAttempt[],
  target: string,
  signature: string,
  history: readonly string[] = [],
): string | undefined {
  const repeated = history.includes(signature)
  const same = repeated || attempts.some(attempt => attempt.target === target && attempt.signature === signature && attempt.verdict !== undefined && verdictFailed(attempt.verdict))
  if (same) {
    return 'these exact parameters were already tried and did not deliver the change: change one thing (the wording, the target, the zone) instead of running them again, and tell the user what you are changing'
  }
  const count = attempts.filter(attempt => attempt.target === target).length
  if (count >= MAX_ATTEMPTS) {
    return `${String(MAX_ATTEMPTS)} attempts on this picture already: do not run it again. Tell the user what is still missing and which attempt came closest`
  }
  return undefined
}

/** The score a verdict gives an attempt: delivered and kept, minus what went wrong. */
function score(verdict: EditVerdict): number {
  let value = verdict.requestedChangeDone === true ? 2 : 0
  for (const ok of Object.values(verdict.preservedOk)) value += ok === true ? 1 : ok === false ? -2 : 0
  value -= verdict.unrequestedChanges.length * 2
  if (verdict.identicalToSource) value -= 4
  return value
}

/**
 * The attempt that came closest, among the ones the pass could judge.
 * @param attempts - the picture's attempts.
 * @returns the best attempt, or undefined when none has a verdict.
 */
export function bestAttempt(attempts: readonly EditAttempt[]): EditAttempt | undefined {
  let best: EditAttempt | undefined
  for (const attempt of attempts) {
    if (attempt.verdict === undefined) continue
    if (best === undefined || score(attempt.verdict) > score(best.verdict as EditVerdict)) best = attempt
  }
  return best
}

/** The localized name of a preserved item. */
export function preserveName(item: PreserveItem): string {
  switch (item) {
    case 'framing': return message('agent.preserveFraming')
    case 'text': return message('agent.preserveText')
    case 'subjects': return message('agent.preserveSubjects')
    case 'style': return message('agent.preserveStyle')
    case 'format': return message('agent.preserveFormat')
  }
}

/** What a verdict says is still missing, in one localized list. */
function gapsOf(verdict: EditVerdict): readonly string[] {
  const gaps: string[] = []
  for (const [item, ok] of Object.entries(verdict.preservedOk)) {
    if (ok === false) gaps.push(preserveName(item as PreserveItem))
  }
  gaps.push(...verdict.missing, ...verdict.unrequestedChanges)
  return gaps
}

/**
 * The report of one picture, built from the verdicts of its attempts.
 *
 * It always names a state — completed, partial or failed — and what is still
 * missing, so the user reads what the checks found and not what the model
 * remembers. The best attempt is named whenever the last one did not win.
 * @param attempts - everything tried on it.
 * @returns the sentences, empty when no attempt has a verdict.
 */
export function attemptReport(attempts: readonly EditAttempt[]): readonly string[] {
  const judged = attempts.filter(attempt => attempt.verdict !== undefined && attempt.file !== undefined)
  const last = judged.at(-1)
  if (last === undefined || last.verdict === undefined || last.file === undefined) return []
  const verdict = last.verdict
  const gaps = gapsOf(verdict)
  const worst = verdict.identicalToSource
  const failed = worst || verdict.requestedChangeDone === false
  const lines: string[] = []
  if (failed) {
    lines.push(message('agent.editFailed', {
      file: last.file,
      why: verdict.identicalToSource ? message('agent.editIdentical') : gaps.length === 0 ? '' : ` — ${gaps.join(', ')}`,
    }))
  } else if (gaps.length > 0) {
    lines.push(message('agent.editPartial', { file: last.file, items: gaps.join(', ') }))
  } else {
    lines.push(message('agent.editCompleted', { file: last.file }))
  }
  const best = bestAttempt(judged)
  if (best !== undefined && best.file !== undefined && best.file !== last.file) {
    const index = judged.indexOf(best) + 1
    lines.push(message('agent.editBest', { file: best.file, n: String(index), total: String(judged.length) }))
  }
  if (attempts.length >= MAX_ATTEMPTS && (failed || gaps.length > 0)) {
    lines.push(message('agent.editStop', { total: String(MAX_ATTEMPTS) }))
  }
  return lines
}

/**
 * The report of every picture this turn verified, as its own paragraph.
 * @param attempts - the turn's attempts, in order.
 * @returns the lines, joined; empty when nothing was verified.
 */
export function editReport(attempts: readonly EditAttempt[]): string {
  const targets = [...new Set(attempts.map(attempt => attempt.target))]
  const lines = targets.flatMap(target => attemptReport(attempts.filter(attempt => attempt.target === target)))
  return lines.length === 0 ? '' : lines.join(' ')
}
