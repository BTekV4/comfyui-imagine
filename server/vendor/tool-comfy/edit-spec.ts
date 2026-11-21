/**
 * What a run is asked to change, and what it must leave alone.
 *
 * A line about a mood became a picture nobody asked for, and the reply then
 * described a loss it never checked (2026-11-21). Words alone did not hold:
 * the run now carries a small, structured spec — the change, the things that
 * stay, and how far the change may go — and the code refuses a run whose
 * arguments contradict it or push the content past the line.
 *
 * The spec is deliberately plain: `preserve` entries are the owner's words
 * normalised to five keys (format, framing, text, subjects, style), so a check
 * can bite without asking the model to fill a schema it would fumble.
 * @module tool-comfy/edit-spec
 */

/** The things a run may be told to keep. */
export type PreserveKey = 'format' | 'framing' | 'text' | 'subjects' | 'style'

/** The spec one run carries. */
export interface EditSpec {
  /** What the user asks for, in their own words: only that. */
  readonly change: string
  /** What must stay as it is. */
  readonly preserve: readonly PreserveKey[]
  /** How far the change goes: "one step" for a "più X", absent otherwise. */
  readonly intensity?: string
}

/** The words that name each thing a run keeps, in the languages the studio speaks. */
const PRESERVE_ALIASES: Readonly<Record<string, PreserveKey>> = {
  format: 'format',
  formato: 'format',
  aspect: 'format',
  'frame shape': 'format',
  'the format': 'format',
  framing: 'framing',
  inquadratura: 'framing',
  composition: 'framing',
  'the composition': 'framing',
  'the framing': 'framing',
  text: 'text',
  testo: 'text',
  'written text': 'text',
  'the text': 'text',
  writing: 'text',
  lettering: 'text',
  subjects: 'subjects',
  subject: 'subjects',
  soggetti: 'subjects',
  people: 'subjects',
  'the subjects': 'subjects',
  style: 'style',
  stile: 'style',
  medium: 'style',
  'the style': 'style',
}

/**
 * A denoise this high repaints the picture: nothing of the source's own frame
 * survives it, so a spec that keeps the framing cannot be run with it.
 */
export const DENOISE_OVER_FRAMING = 0.6

/** The words that ask for nudity or explicit content, in the studio's languages. */
const EXPLICIT = /\b(nud[oaie]|nudit[àa]|naked|nude|topless|undressed|spogliat[oaie]|senza veli|senza vestiti|explicit|esplicit[oaie]|bare breasts|seni scoperti|seno scoperto)\b/iu

/** Whether a text asks for nudity or explicit content. */
export function asksExplicit(text: string): boolean {
  return EXPLICIT.test(text)
}

/**
 * Read the spec a run carries.
 *
 * A model that wrote none gets the plainest one that still holds: the user's
 * own line as the change, nothing claimed as kept. The instruction asks for the
 * full spec, and this keeps an older or a terse caller from running without
 * one at all.
 * @param raw - the model's `spec` argument.
 * @param asked - the user's line, for the fallback and for the change.
 * @returns the spec, never undefined.
 */
export function readEditSpec(raw: unknown, asked: string): EditSpec {
  const object = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const change = typeof object['change'] === 'string' && object['change'].trim() !== ''
    ? object['change'].trim()
    : asked.trim()
  const preserve: PreserveKey[] = []
  const rawPreserve = object['preserve']
  if (Array.isArray(rawPreserve)) {
    for (const entry of rawPreserve) {
      if (typeof entry !== 'string') continue
      const key = PRESERVE_ALIASES[entry.trim().toLowerCase()]
      if (key !== undefined && !preserve.includes(key)) preserve.push(key)
    }
  }
  const intensity = typeof object['intensity'] === 'string' && object['intensity'].trim() !== ''
    ? object['intensity'].trim()
    : undefined
  return { change, preserve, ...intensity === undefined ? {} : { intensity } }
}

/** What a run's arguments say, for the checks that need them. */
export interface SpecContext {
  /** The user's line. */
  readonly asked: string
  /** The prompt about to be drawn. */
  readonly prompt: string
  /** Whether the call changes the frame shape the source has. */
  readonly changesShape: boolean
  /** The denoise the call sets for itself, when it sets one. */
  readonly denoise?: number
  /** Whether the run edits a picture (a source is given). */
  readonly edit: boolean
}

/**
 * Why a run contradicts its own spec, or undefined when it holds.
 *
 * Only the contradictions a machine can see are refused here — a shape the
 * spec says is kept and the call changes, a denoise that repaints the framing
 * it claims to keep, content the line never asked for. What needs eyes is the
 * verification's business, not this function's.
 * @param spec - the run's spec.
 * @param context - the arguments it will run with.
 * @returns the refusal, or undefined.
 */
export function specRefusal(spec: EditSpec, context: SpecContext): string | undefined {
  if (context.edit && spec.preserve.includes('format') && context.changesShape) {
    return 'the spec says the format stays and the call changes it: drop `aspect`, or stop claiming the format is kept'
  }
  if (context.denoise !== undefined && context.denoise > DENOISE_OVER_FRAMING
    && (spec.preserve.includes('framing') || spec.preserve.includes('style'))) {
    return `a denoise of ${String(context.denoise)} repaints the picture, and the spec says the ${spec.preserve.includes('framing') ? 'framing' : 'style'} stays: lower the denoise, or drop that line from the spec`
  }
  /*
   * Never further than the line: a prompt that asks for nudity the user did
   * not ask for is refused before anything is queued, whatever the reason.
   */
  if (asksExplicit(spec.change) !== asksExplicit(context.asked) || (!asksExplicit(context.asked) && asksExplicit(context.prompt))) {
    return 'the line does not ask for nudity or explicit content, and this run would: keep the change to what the user asked for, at the mood they named'
  }
  return undefined
}

/** The most runs one request may take before the turn stops and reports. */
export const MAX_ATTEMPTS = 3

/** One run of a request, as the turn remembers it. */
export interface RunAttempt {
  /** What the attempt is about: the action and, for an edit, its source. */
  readonly key: string
  /** The parameters, hashed: the same fingerprint is the same attempt. */
  readonly fingerprint: string
  /** What came of it. */
  readonly state: 'ran' | 'failed' | 'kept'
}

/**
 * The key a request's attempts are filed under.
 * @param action - the studio action.
 * @param source - the picture being edited, when there is one.
 * @returns the key.
 */
export function runKey(action: string, source?: string): string {
  return source === undefined ? action : `${action}:${source}`
}

/**
 * The fingerprint of one run's parameters: the same values mean the same run.
 *
 * Keys are sorted so two objects written in a different order are the same
 * attempt, which is the point: the agent must change something, not retype it.
 * @param parts - the arguments that decide what the run makes.
 * @returns a stable string.
 */
export function attemptFingerprint(parts: Readonly<Record<string, unknown>>): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
    }
    return value
  }
  return JSON.stringify(stable(parts))
}

/**
 * Why a run may not start: the attempt budget is spent, or this exact run was
 * already made and failed.
 * @param attempts - the request's attempts so far.
 * @param key - the request's key.
 * @param fingerprint - this run's parameters.
 * @returns the refusal, or undefined.
 */
export function attemptRefusal(attempts: readonly RunAttempt[], key: string, fingerprint: string): string | undefined {
  const mine = attempts.filter(attempt => attempt.key === key)
  if (mine.some(attempt => attempt.fingerprint === fingerprint && attempt.state !== 'kept')) {
    return 'you already ran exactly these parameters and they did not give what was asked: change one thing that matters (the wording of the change, a zone, the shape) instead of repeating them'
  }
  if (mine.length >= MAX_ATTEMPTS) {
    return `this request has had ${String(MAX_ATTEMPTS)} attempts: stop here, keep the best result, and say in the reply what is still missing`
  }
  return undefined
}
