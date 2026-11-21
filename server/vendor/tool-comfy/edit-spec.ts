/**
 * What one run is asked to change, and what it may not lose.
 *
 * Measured on 2026-11-21: a "more sensual" edit came back with a bare breast
 * nobody asked for, and another edit silently dropped the lettering of the
 * photo. The reply was written from memory, so neither fault was named. A run
 * now starts from a spec built before it is queued: the change (the user's
 * words and nothing else), what has to stay (framing, visible text, subjects,
 * style, format), and whether "more X" means one step. The code refuses a run
 * that contradicts its own spec, and the vision pass checks the result against
 * it.
 * @module tool-comfy/edit-spec
 */

import { escalatedLabels } from './explicitness.ts'
import type { WorkflowScalar } from '../../../shared/imagine-chat.ts'

/** The things an edit keeps unless the line asks for them to change. */
export type PreserveItem = 'framing' | 'text' | 'subjects' | 'style' | 'format'

/** Every preserve item, in the order the instruction lists them. */
export const PRESERVE_ITEMS: readonly PreserveItem[] = ['framing', 'text', 'subjects', 'style', 'format']

/** The structured request one run is built from. */
export interface EditSpec {
  /** The one change the user asked for, in their own words. */
  readonly change: string
  /** What the run must keep from the source. */
  readonly preserve: readonly PreserveItem[]
  /** "più X" is a step from the last result, not a new request. */
  readonly intensity: 'as-asked' | 'one-step'
}

/** The words that say the line itself wants that item changed. */
const ASKS_TO_CHANGE: Readonly<Record<PreserveItem, RegExp>> = {
  format: /\b(?:\d{1,2}:\d{1,2}|verticale|orizzontale|quadrat[oa]|formato|ritaglia\w*|cropp?\w*|portrait|landscape|square|vertical|horizontal|aspect)\b/i,
  framing: /\b(?:inquadratura|inquadra\w*|zoom|primo piano|close[- ]?up|figura intera|grandangolo|dall['’]alto|dal basso|framing|full body|taglia\w*)\b/i,
  text: /\b(?:scritt[ae]|testo|titolo|lettering|text|writing|insegna)\b/i,
  style: /\b(?:stile|style|look|estetica|aesthetic)\b/i,
  subjects: /\b(?:cambia (?:la |il )?(?:persona|soggetto)|sostituisci (?:la persona|il soggetto|la donna|l['’]uomo)|another person|different person|remove (?:the )?person)\b/i,
}

/** "più", "meno", "more", "less": a step from the result already accepted. */
const STEP_WORD = /(?<![\p{L}])(?:più|meno|more|less)(?![\p{L}])/iu

/**
 * Build the spec of one run from the user's line.
 *
 * The line is the authority: an edit keeps everything it does not name, and a
 * dimension the line names is not preserved (asking for 9:16 is asking to
 * change the format). A generation has no source, so nothing is preserved.
 * @param asked - the user's line.
 * @param options - whether the run starts from a picture, and the change the
 *   model wrote (the prompt), which only narrows the spec, never widens it.
 * @returns the spec the run and the check are built on.
 */
export function specFor(
  asked: string,
  options: { readonly edit: boolean; readonly change?: string },
): EditSpec {
  const change = (options.change ?? asked).trim()
  const preserve = options.edit
    ? PRESERVE_ITEMS.filter(item => !ASKS_TO_CHANGE[item].test(asked))
    : []
  return {
    change: change.length === 0 ? asked.trim() : change,
    preserve,
    intensity: STEP_WORD.test(asked) ? 'one-step' : 'as-asked',
  }
}

/** What a run's own arguments change, for the spec's checks. */
export interface SpecRun {
  /** The source picture's shape, when it is measured. */
  readonly sourceShape?: string
  /** The frame shape the call asks for, when it asks for one. */
  readonly aspect?: string
  /** The values the call writes on the run (custom fields and tweaks). */
  readonly fields?: Readonly<Record<string, WorkflowScalar>>
}

/** Above this, a denoise redraws the whole frame instead of one zone. */
const FRAMING_DENOISE = 0.55

/**
 * The faults a call commits against its own spec.
 *
 * Only what the code can see: a frame shape the user did not ask to change,
 * and a denoise high enough to redraw the whole picture when the framing has
 * to stay. The rest — whether the change landed, what was lost — is the
 * vision pass's job, because no argument can answer it.
 * @param spec - the run's spec.
 * @param run - the arguments the call carries.
 * @returns one sentence per violation, empty when the call keeps its spec.
 */
export function specRefusals(spec: EditSpec, run: SpecRun): readonly string[] {
  const refusals: string[] = []
  if (spec.preserve.includes('format') && run.aspect !== undefined && run.sourceShape !== undefined && run.aspect !== run.sourceShape) {
    refusals.push(`the user did not ask to change the frame: it is ${run.sourceShape} and the call asks ${run.aspect}. Keep the format, or ask them first`)
  }
  if (spec.preserve.includes('framing') && run.fields !== undefined) {
    for (const [key, value] of Object.entries(run.fields)) {
      if (!/\.denoise$/i.test(key) || typeof value !== 'number') continue
      if (value <= FRAMING_DENOISE) continue
      refusals.push(`a denoise of ${String(value)} (${key}) redraws the whole frame, and the user asked to keep the framing: change only the part they named, with target or region`)
    }
  }
  return refusals
}

/**
 * The refusal a change that adds nudity or explicit content gets.
 *
 * "Sensuale" is not "nudo": a run may deliver what the line says and nothing
 * further. The words the user wrote are the permission, and this checks the
 * change against them.
 * @param change - the prompt about to run.
 * @param asked - the user's line.
 * @returns the refusal, or undefined when the change stays inside the line.
 */
export function explicitnessRefusal(change: string, asked: string): string | undefined {
  const added = escalatedLabels(change, asked)
  if (added.length === 0) return undefined
  const what = added.length === 1 ? added[0] : added.join(' and ')
  return `the change adds ${what} that the line did not ask for: run only what the user wrote, or ask them first. "More sensual" is not "nude"`
}
