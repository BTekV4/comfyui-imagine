/**
 * The wording of an edit that touches one part of a photo.
 *
 * The studio's photo edit draws the whole picture again: the Krea 2 edit
 * graph runs at full denoise with no mask, so everything the prompt mentions
 * is a candidate for a redraw. A short instruction that names only the part
 * to change, and a fixed sentence that asks for the rest to stay as it is,
 * is the only wording a full redraw reads as "change this, not the picture".
 * A grounded prompt that also lists the clothing, the body and the background
 * reads as a description of the scene, and the sampler redraws that too —
 * measured on 2026-11-17: two "remove the extra arm" edits rewrote the whole
 * photo (the person's body among it) and never removed the arm.
 *
 * The fix is not a filter and not a refusal: it is that the part to change is
 * named and the rest is asked to stay, in as few words as possible. When a
 * part has to come out without touching what is around it, the honest tool is
 * the masked removal (IOPaint's Remove object), and the studio says so after a
 * full redraw has failed twice.
 *
 * Shared, and so free of Node and of the DOM.
 * @module imagine-edit
 */

/**
 * The sentence every local edit ends with.
 *
 * Fixed on purpose: it is the same wording for every run, it never lists what
 * must stay (a list is a description, and a description is what gets
 * redrawn), and the vision pass is told to end its prompt with it.
 */
export const LOCAL_EDIT_KEEP =
  'Keep everything else exactly the same: the same person, the same clothing, the same pose, the same framing, the same light and the same background.'

/** Most characters the change itself may take before the keep sentence. */
export const LOCAL_EDIT_CHARS = 300

/**
 * The verbs that ask for one part of a photo to change.
 *
 * Removal, addition, movement and replacement, in the two languages the
 * studio is spoken in. A global restyle is deliberately absent: "redraw it as
 * an anime frame" is not a local edit and must keep the whole picture free.
 */
const LOCAL_VERB =
  /\b(?:rimuov\w*|rimoss\w*|togli\w*|tolt\w*|elimina\w*|cancella\w*|aggiung\w*|inserisc\w*|metti|mettere|sposta\w*|sostituisc\w*|remove\w*|take\s+out|erase\w*|delete\w*|add(?:s|ed|ing)?|insert\w*|put|move\w*|replace\w*|swap\w*)\b/i

/** The verbs that take something out: the masked removal's own case. */
const REMOVAL_VERB = /\b(?:rimuov\w*|rimoss\w*|togli\w*|tolt\w*|elimina\w*|cancella\w*|remove\w*|take\s+out|erase\w*|delete\w*)\b/i

/** A change limited by "solo"/"only", the other way a local edit is asked for. */
const ONLY_CHANGE = /\b(?:cambia|cambiare|change|modify)\b[^.]{0,40}\b(?:solo|soltanto|only)\b/i

/** A restyle: the whole photo is meant to change, so it is not a local edit. */
const RESTYLE = /\b(?:stile|style|restyle|trasform\w*|turn\s+(?:it|this)\s+into|redraw\s+(?:it|this)\s+as)\b/i

/**
 * Where a prompt stops naming the change and starts listing the scene.
 *
 * "…leaving no trace of it; keep all other parts unchanged, including the
 * jacket and the …" is the shape the vision pass wrote on 2026-11-17,
 * and the list is the part a full redraw copies. Everything from this clause
 * on is dropped and replaced by the fixed sentence.
 */
const KEEP_RECITAL =
  /\b(?:keep|keeping|leave|leaving)\s+(?:everything|all)\b[^.;]{0,60}?\b(?:unchanged|the\s+same|as\s+it\s+is)\b/i

/**
 * Whether a line asks for one part of a photo to change.
 * @param text - the user's line, or the template's own wording.
 * @returns true for removal, addition, movement and replacement.
 */
export function isLocalEdit(text: string): boolean {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length === 0 || RESTYLE.test(line)) return false
  return LOCAL_VERB.test(line) || ONLY_CHANGE.test(line)
}

/**
 * Whether a line asks for something to be taken out.
 *
 * A removal is the case a full redraw cannot deliver: the model rebuilds the
 * part instead of leaving the gap, and the masked eraser is what removes it.
 * An addition or a replacement is still local, but the same two-try rule does
 * not hand it to the eraser.
 * @param text - the user's line, or the run's prompt.
 * @returns true for removal only.
 */
export function isRemovalEdit(text: string): boolean {
  return REMOVAL_VERB.test(text)
}

/**
 * Whether the user is saying that the last edit did not do what was asked.
 *
 * Only the words that can only be a complaint: "ancora" alone also means
 * "one more", and a run asked for again is not a failed run.
 * @param text - the user's line.
 * @returns true when the line reports the last result as still wrong.
 */
export function isEditComplaint(text: string): boolean {
  return /(?:^|[\s,;])(?:c'?e|ce|è|e')\s+ancora\b|\bancora\s+(?:li|lì|presente)\b|\bnon\s+(?:l'|lo\s+|la\s+)?hai\s+(?:rimosso|tolto|cambiato|fatto|aggiunto|messo|spostato|sostituito)\b|\bnon\s+(?:e'|è)\s+cambiato\b|\bstill\s+(?:there|has|in)\b|\bdidn'?t\s+(?:remove|work|change)\b|\bnot\s+removed\b|\bhasn'?t\s+changed\b/i.test(text)
}

/** One run of a photo chain, as the file's note records it. */
export interface EditRun {
  /** The output file's name. */
  readonly name: string
  /** The studio action that made it (`remix` for an edit). */
  readonly action: string
  /** The prompt the run was given. */
  readonly prompt: string
  /** The file the run started from. */
  readonly source?: string
}

/**
 * Where an edit chain starts, and how many local edits have already failed.
 *
 * A correction is only worth asking of the picture the chain started from:
 * every pass over a failed output keeps the change the user is complaining
 * about and adds its own. Walking back also counts the attempts, which is
 * what tells the studio that a full redraw has had its two tries.
 * @param name - the output the user is talking about.
 * @param runs - the chain's runs, by output name.
 * @returns the root source and the attempts made on it, or undefined when
 *   `name` is not the output of a local edit.
 */
export function editChain(name: string, runs: readonly EditRun[]): { readonly root: string; readonly attempts: number } | undefined {
  const byName = new Map(runs.map(run => [run.name, run]))
  let current = byName.get(name)
  if (current === undefined) return undefined
  let root: string | undefined
  let attempts = 0
  const seen = new Set<string>()
  while (current !== undefined && current.action === 'remix' && isLocalEdit(current.prompt)) {
    if (current.source === undefined || seen.has(current.name)) break
    seen.add(current.name)
    root = current.source
    attempts += 1
    current = byName.get(current.source)
  }
  return root === undefined || attempts === 0 ? undefined : { root, attempts }
}

/** A prompt on one line, without the whitespace a model likes to add. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Drop the conjunction and punctuation a cut may leave behind. */
function tidyEnd(text: string): string {
  return text
    .replace(/[\s,;:.–—-]+$/u, '')
    .replace(/\s+(?:and|with|while|but|in|on|at|to|of|the|a|an|her|his|its)$/i, '')
    .trim()
}

/** The longest prefix of `text` that ends on a word boundary. */
function cutAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return space > limit / 2 ? cut.slice(0, space) : cut
}

/** The fields a run needs for the retry rules: what it does, and what it starts from. */
export interface RetryableIntent {
  readonly action: string
  readonly source?: string
}

/** What the retry rules did to the runs a reading queued. */
export interface EditRetry<T> {
  /** The runs to queue, with the sources the rules allow. */
  readonly intents: readonly T[]
  /** True when a source was moved back to the root of its chain. */
  readonly rewound: boolean
  /** True when two redraws have failed and no third is allowed. */
  readonly escalated: boolean
}

/**
 * Keep a correction on the photo it belongs to, and stop a third redraw.
 *
 * Applied to whatever a reading queued, on top of the source it chose: on
 * 2026-11-17 two corrections were asked of the failed output, so each pass kept
 * the change the user was complaining about and added its own. A correction
 * starts from the root of the chain instead. After two local edits on the same
 * root, the runs are dropped: no third full redraw, and the caller says which
 * masked tool does the removal.
 * @param intents - the runs the reading queued.
 * @param runs - the project's files, with how each was made.
 * @param text - the user's line.
 * @returns the runs to queue, and what the rules did.
 */
export function retryEditIntents<T extends RetryableIntent>(
  intents: readonly T[],
  runs: readonly EditRun[],
  text: string,
): EditRetry<T> {
  if (!isEditComplaint(text)) return { intents, rewound: false, escalated: false }
  let rewound = false
  let escalated = false
  const kept: T[] = []
  for (const intent of intents) {
    const chain = intent.action === 'remix' && intent.source !== undefined
      ? editChain(intent.source, runs)
      : undefined
    if (chain === undefined) {
      kept.push(intent)
      continue
    }
    if (chain.attempts >= 2 && isRemovalEdit(runs.find(run => run.name === intent.source)?.prompt ?? '')) {
      escalated = true
      continue
    }
    if (chain.root !== intent.source) {
      rewound = true
      kept.push({ ...intent, source: chain.root })
      continue
    }
    kept.push(intent)
  }
  return { intents: kept, rewound, escalated }
}

/**
 * The prompt one local edit is sent with.
 *
 * The change itself, in the model's own words when they are usable, then the
 * fixed sentence. Whatever a grounded prompt said about the rest of the photo
 * is dropped rather than forwarded: naming the clothing and the body is what
 * a full redraw latches onto.
 * @param written - the grounded prompt the vision pass wrote, when it wrote one.
 * @param intent - the user's own line, or the template's wording.
 * @returns the prompt, never empty when `intent` is not.
 */
export function localEditPrompt(written: string | undefined, intent: string): string {
  const grounded = oneLine(written ?? '')
  let change = oneLine(grounded.length === 0 ? intent : grounded)
  const recital = change.search(KEEP_RECITAL)
  if (recital > 0) change = change.slice(0, recital)
  change = tidyEnd(change)
  if (change.length < 12) change = tidyEnd(oneLine(intent))
  if (change.length > LOCAL_EDIT_CHARS) change = tidyEnd(cutAtWord(change, LOCAL_EDIT_CHARS))
  if (change.length === 0) return LOCAL_EDIT_KEEP
  return change.toLowerCase().includes(LOCAL_EDIT_KEEP.toLowerCase())
    ? change
    : `${change} ${LOCAL_EDIT_KEEP}`
}
