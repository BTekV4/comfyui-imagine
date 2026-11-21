/**
 * What the studio remembers about a picture it is editing.
 *
 * A chat turn used to forget everything the previous one learned: "now a
 * little more" started from nothing, and the same failed combination was
 * tried again the next day. The state is filed beside the studio's other
 * per-file records and outlives the turn and the process: the last accepted
 * result with the change that produced it, the last verdict, and the
 * combinations that already failed.
 *
 * A step ("più X") starts from the accepted change and adds one delta from the
 * whitelist; a failed combination is named in the instruction and refused by
 * the code, so the model has to change strategy rather than words.
 * @module tool-comfy/edit-state
 */

import { readFile } from 'node:fs/promises'
import { serialized, writeFileAtomic } from '../atomic-write/index.ts'
import { producedFilePath } from './written-prompts.ts'
import type { EditSpec, PreserveItem } from './edit-spec.ts'
import type { EditVerdict } from './edit-verify.ts'

/** One accepted result: what produced it, and what the check said. */
export interface RememberedStep {
  /** The result file's name. */
  readonly file: string
  /** The change it was accepted for. */
  readonly change: string
  /** The spec it ran under. */
  readonly spec: EditSpec
  /** The verdict that accepted it. */
  readonly verdict: EditVerdict
}

/** One combination that failed on this picture. */
export interface FailedTry {
  /** The arguments that decide the picture, as `signatureOf` builds them. */
  readonly signature: string
  /** The change it was asked for. */
  readonly change: string
  /** Why it failed, in the check's own words. */
  readonly reason: string
}

/** Everything filed about one picture being edited. */
export interface EditState {
  /** The last result the checks accepted. */
  readonly accepted?: RememberedStep
  /** The verdict of the last attempt, accepted or not. */
  readonly lastVerdict?: EditVerdict
  /** The combinations already tried and failed, newest last. */
  readonly failed: readonly FailedTry[]
}

/** How many failed combinations are kept: the recent ones, not a diary. */
const MAX_FAILED = 12

/** Where one picture's edit state is kept. */
function statePath(name: string): string | undefined {
  return producedFilePath('edits', name, '.json')
}

/** The strings of an array, keeping only what the state can carry. */
function stringList(value: unknown, max: number): readonly string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.replace(/\s+/g, ' ').trim())
    .filter(entry => entry.length > 0)
    .slice(0, max)
}

/** A verdict read back off disk, dropping anything that is not its shape. */
function verdictOf(value: unknown): EditVerdict | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const preservedOk: Partial<Record<PreserveItem, boolean>> = {}
  if (typeof record['preservedOk'] === 'object' && record['preservedOk'] !== null) {
    for (const [item, ok] of Object.entries(record['preservedOk'] as Record<string, unknown>)) {
      if (typeof ok === 'boolean') preservedOk[item as PreserveItem] = ok
    }
  }
  return {
    ...typeof record['requestedChangeDone'] === 'boolean' ? { requestedChangeDone: record['requestedChangeDone'] } : {},
    preservedOk,
    textFound: stringList(record['textFound'], 20),
    unrequestedChanges: stringList(record['unrequestedChanges'], 20),
    identicalToSource: record['identicalToSource'] === true,
    missing: stringList(record['missing'], 20),
    ...typeof record['description'] === 'string' && record['description'].trim().length > 0
      ? { description: record['description'].trim() }
      : {},
  }
}

/** A spec read back off disk. */
function specOf(value: unknown): EditSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record['change'] !== 'string') return undefined
  const preserve = stringList(record['preserve'], 8)
    .filter((item): item is PreserveItem => ['framing', 'text', 'subjects', 'style', 'format'].includes(item))
  return {
    change: record['change'],
    preserve,
    intensity: record['intensity'] === 'one-step' ? 'one-step' : 'as-asked',
  }
}

/** Read a picture's edit state. */
export async function recallEditState(name: string): Promise<EditState | undefined> {
  const path = statePath(name)
  if (path === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const accepted = typeof record['accepted'] === 'object' && record['accepted'] !== null
      ? record['accepted'] as Record<string, unknown>
      : undefined
    const spec = accepted === undefined ? undefined : specOf(accepted['spec'])
    const verdict = accepted === undefined ? undefined : verdictOf(accepted['verdict'])
    const failed: FailedTry[] = []
    if (Array.isArray(record['failed'])) {
      for (const entry of record['failed']) {
        if (typeof entry !== 'object' || entry === null) continue
        const tryRecord = entry as Record<string, unknown>
        if (typeof tryRecord['signature'] !== 'string' || typeof tryRecord['change'] !== 'string') continue
        failed.push({
          signature: tryRecord['signature'],
          change: tryRecord['change'],
          reason: typeof tryRecord['reason'] === 'string' ? tryRecord['reason'] : '',
        })
      }
    }
    const lastVerdict = verdictOf(record['lastVerdict'])
    return {
      ...accepted !== undefined && typeof accepted['file'] === 'string' && typeof accepted['change'] === 'string' && spec !== undefined && verdict !== undefined
        ? { accepted: { file: accepted['file'], change: accepted['change'], spec, verdict } }
        : {},
      ...lastVerdict === undefined ? {} : { lastVerdict },
      failed: failed.slice(-MAX_FAILED),
    }
  } catch {
    return undefined
  }
}

/**
 * File a picture's edit state.
 *
 * Never throws: a state that cannot be filed costs the next turn one step's
 * starting point, which is not worth failing a finished edit over.
 * @param name - the source picture's name.
 * @param state - what is known about it now.
 */
export async function rememberEditState(name: string, state: EditState): Promise<void> {
  const path = statePath(name)
  if (path === undefined) return
  const body: EditState = { ...state, failed: state.failed.slice(-MAX_FAILED) }
  try {
    await serialized(path, async () => {
      await writeFileAtomic(path, JSON.stringify(body), { mode: 0o600 })
    })
  } catch {
    // Filed on a best-effort basis; see the module note.
  }
}

/** The failed combinations of one picture, in the instruction's words. */
function failedLine(state: EditState): string | undefined {
  if (state.failed.length === 0) return undefined
  const last = state.failed.slice(-3).map(entry => `«${entry.change}»${entry.reason.length === 0 ? '' : ` (${entry.reason})`}`).join(', ')
  return `failed and refused again: ${last}`
}

/**
 * What the instruction says about the pictures it already worked on.
 *
 * The model reads the accepted change each picture starts from and the
 * combinations that failed, so a "più X" starts from the result the user
 * accepted and a retry changes strategy instead of words.
 * @param names - the pictures the turn knows about.
 * @returns one line per picture with something filed, at most ten.
 */
export async function editStateNotes(names: readonly string[]): Promise<readonly string[]> {
  const images = [...new Set(names)].slice(0, 10)
  const states = await Promise.all(images.map(async name => ({ name, state: await recallEditState(name).catch(() => undefined) })))
  const lines: string[] = []
  for (const { name, state } of states) {
    if (state === undefined) continue
    const parts: string[] = []
    if (state.accepted !== undefined) parts.push(`last accepted «${state.accepted.change}» as ${state.accepted.file}`)
    const failed = failedLine(state)
    if (failed !== undefined) parts.push(failed)
    if (state.lastVerdict?.missing.length === 0 && state.lastVerdict?.unrequestedChanges.length === 0 && state.lastVerdict?.requestedChangeDone !== true) {
      parts.push('the last attempt did not deliver the change')
    }
    if (parts.length > 0) lines.push(`- ${name}: ${parts.join('; ')}`)
  }
  return lines
}
