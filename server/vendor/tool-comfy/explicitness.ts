/**
 * The few words that name nudity or explicit content, and the code that keeps
 * them from arriving unasked.
 *
 * Measured on 2026-11-21: the user asked for a "more sensual" edit, the agent
 * raised a LoRA weight and the result carried a bare breast nobody asked for;
 * the reply then denied it. "Sensual" is not "nude": a run never adds these
 * words on its own, and a result that carries them unasked is reported, never
 * sold as a success.
 *
 * The list is deliberately small and spelled in the studio's two languages. It
 * is a guard, not a censor: a word the user wrote themselves is allowed
 * through unchanged.
 * @module tool-comfy/explicitness
 */

/** One term, with the words that stand for it in a refusal. */
interface ExplicitTerm {
  /** A stable label, used to compare what the change says with what was asked. */
  readonly label: string
  readonly pattern: RegExp
}

/**
 * Nudity and explicit content, as words.
 *
 * A photograph of a nude is a legitimate request; this list only decides
 * whether the agent *added* the idea. The patterns are anchored on word
 * boundaries so "denudo" or "snudo" cannot match a fragment.
 */
const TERMS: readonly ExplicitTerm[] = [
  { label: 'nudity', pattern: /\bnud[oaie]\b|\bnaked\b/gi },
  { label: 'nudity', pattern: /\btopless\b/gi },
  { label: 'nudity', pattern: /\b(?:seno|petto|petti)\s+(?:nud[oi]|scopert[oi])\b|\bbare breasts?\b|\bbreasts?\s+(?:bare|exposed)\b/gi },
  { label: 'nudity', pattern: /\b(?:capezzol[oi]|nipples?)\b/gi },
  { label: 'nudity', pattern: /\b(?:tett[ae]|tette)\b/gi },
  { label: 'explicitness', pattern: /\b(?:esplicit[oaie]|explicit|nsfw)\b/gi },
  { label: 'explicitness', pattern: /\bporn\w*\b/gi },
  { label: 'explicitness', pattern: /\bspogliat[oaie]\b|\bundress(?:ed|ing)?\b/gi },
]

/**
 * The labels of the explicit ideas a text carries.
 * @param text - a prompt, a line, a description.
 * @returns the labels, without duplicates, in the order they first appear.
 */
export function explicitLabels(text: string): readonly string[] {
  const found: string[] = []
  for (const term of TERMS) {
    term.pattern.lastIndex = 0
    if (term.pattern.test(text) && !found.includes(term.label)) found.push(term.label)
  }
  return found
}

/**
 * The explicit ideas one run would add that the user did not ask for.
 *
 * The user's own words are the permission: a line saying "un nudo artistico"
 * allows nudity, and "più sensuale" does not.
 * @param change - the prompt or the change about to run.
 * @param asked - the user's line.
 * @returns the labels the change carries and the line does not.
 */
export function escalatedLabels(change: string, asked: string): readonly string[] {
  const allowed = new Set(explicitLabels(asked))
  return explicitLabels(change).filter(label => !allowed.has(label))
}

/** A negation within one clause of an explicit word. */
const DENIAL = /\b(?:non|no|mai|nessun[oa]?|senza|not|never|without|didn't|did not|no)\b[^.!?;]{0,60}\b(?:nud[oaie]|naked|topless|seno|breast|nipple|capezzol|tett[ae]|esplicit|explicit|nsfw|spogliat|undress)/gi

/**
 * Whether a reply denies the nudity or explicit content a description reports.
 *
 * The shape that reached the user on 2026-11-21 was "non l'ho fatta nuda",
 * written while the vision pass described a bare breast. A denial in the same
 * clause as one of the words is the contradiction; a plain description of the
 * content is not.
 * @param reply - what the model wrote.
 * @returns true when the reply denies the content.
 */
export function deniesExplicitness(reply: string): boolean {
  DENIAL.lastIndex = 0
  return DENIAL.test(reply)
}
