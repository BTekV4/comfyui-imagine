/**
 * Who the studio draws, as data instead of code.
 *
 * The paragraph a deployment draws its person from used to be a constant of the
 * module, so the code could only ever draw the one person it was written for.
 * It lives in a JSON file named by `toolComfy.persona` in `config.yaml` now, and
 * the repo ships a neutral example: change the file, change the person.
 *
 * The graphs carry no LoRA switch of their own — a graph that turned a LoRA on
 * from words in the prompt was removed on 3/11/2026 — so this paragraph is
 * prompt text and nothing else: it describes the person, it does not activate
 * anything.
 *
 * Two parts are read: the whole paragraph, which «Ricrea video» puts in front
 * of the frame it redraws, and the hair, pinned in the Krea 2 prompt so the
 * source frame cannot win. The `opening` and `closing` a persona file may still
 * carry were for the person swap, removed on 2026-11-13, and are ignored.
 * @module tool-comfy/persona
 */

import { readFileSync } from 'node:fs'

/** One person the studio can draw, as the prompts describe them. */
export interface Persona {
  /** The paragraph every draw that must show this person starts its prompt with. */
  readonly identity: string
  /** The hair described in the text, pinned so the source frame cannot win. Empty leaves the text alone. */
  readonly hair: string
}

/**
 * What a deployment without a persona file draws: a neutral, undescribed person.
 *
 * Deliberately vague — the point of the file is that the deployment supplies the
 * paragraph — but valid, so the studio boots and every action works before
 * anyone has written one.
 */
export const DEFAULT_PERSONA: Persona = {
  identity: 'The subject, a person standing alone in the photograph, lit naturally and photographed from the front.',
  hair: '',
}

let active: Persona = DEFAULT_PERSONA

/** The persona in force: the one the boot loaded, or {@link DEFAULT_PERSONA}. */
export function activePersona(): Persona {
  return active
}

/**
 * Put a persona in force for the rest of the process.
 * @param next - the persona to use, or undefined to fall back to the default.
 */
export function setPersona(next: Persona | undefined): void {
  active = next ?? DEFAULT_PERSONA
}

/**
 * Read a persona file.
 *
 * A missing file is not an error: the deployment may simply not have one yet.
 * A file that exists and does not fit is, because a half-read persona would
 * draw the wrong person rather than fail.
 * @param path - the file named by `toolComfy.persona`; undefined when unset.
 * @returns the persona, or undefined when there is no file.
 * @throws {Error} when the file cannot be read or `identity` is missing.
 */
export function loadPersona(path: string | undefined): Persona | undefined {
  if (path === undefined || path === '') return undefined
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    throw new Error(`cannot read persona file ${path}: ${String(error)}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    throw new Error(`persona file ${path} is not valid JSON: ${String(error)}`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`persona file ${path} must be a JSON object`)
  }
  const fields = parsed as Record<string, unknown>
  const text = (name: string): string => {
    const value = fields[name]
    if (typeof value !== 'string') throw new Error(`persona file ${path}: "${name}" must be a string`)
    return value
  }
  const identity = text('identity').trim()
  if (identity.length === 0) throw new Error(`persona file ${path}: "identity" is empty`)
  const hair = fields.hair === undefined ? '' : text('hair').trim()
  return { identity, hair }
}
