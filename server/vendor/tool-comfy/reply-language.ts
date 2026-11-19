/**
 * The language a reply was written in, and the one instruction that asks for
 * it again.
 *
 * The studio writes in the interface's language, whatever language the user
 * wrote in. A model that calls tools reads a trace of English JSON (states,
 * file names, errors) and sometimes answers in English even after being told
 * otherwise; the loop asks once more, with the reply it already wrote and no
 * tools, when this check says the reply is in another language.
 *
 * The check is a word heuristic, not a language detector: the studio's own
 * languages are English and Italian, and a reply with neither enough English
 * nor enough Italian words is left alone rather than rewritten on a guess.
 * @module tool-comfy/reply-language
 */

import { languageName } from '../../../shared/locale-names.ts'

/** The languages this check can tell apart. */
export type ReplyLanguage = 'it' | 'en' | 'unknown'

/** Italian function words and the studio's own nouns. */
const ITALIAN = /\b(il|lo|la|i|gli|le|un|una|uno|di|del|della|dei|delle|che|per|con|non|sono|è|ecco|fatto|fatte|fatti|due|tre|quattro|varianti|versioni|questa|questo|queste|questi|foto|immagine|immagini|tazza|tavolo|luce|colore|sfondo|scuro|più|anche|come|prima|nella|sulla|dal|al|alle|agli|ora|nuova|nuovo|versione|risultato|file|video|secondi|formato|verticale|orizzontale|quadrata|quadrato|e|ma|se|quando|dove|cosa|chi|perché|senza|tra|fra|molto|poco|bene)\b/gi

/** English function words and the studio's own nouns. */
const ENGLISH = /\b(the|a|an|is|are|was|were|of|and|with|this|that|these|those|has|have|had|image|photo|picture|done|here|your|it|its|but|from|into|more|darker|background|light|colour|color|result|file|video|seconds|format|vertical|horizontal|square|now|new|version|the|as|at|by|for|on|in|to|or|if|when|where|what|who|why|without|between|very|little|well)\b/gi

/** How many words a reply needs before the check is worth making. */
const MIN_WORDS = 4

/**
 * The language of one written reply, from the words it uses.
 *
 * Italian accents are counted too: a short Italian sentence ("È più scuro")
 * is mostly function words the lists share, and `è` is the one mark English
 * never carries.
 * @param text - the reply.
 * @returns `it`, `en`, or `unknown` when the evidence is too thin.
 */
export function languageOfReply(text: string): ReplyLanguage {
  const words = text.trim().split(/\s+/).filter(word => word !== '')
  if (words.length < MIN_WORDS) return 'unknown'
  const italian = (text.match(ITALIAN) ?? []).length + (text.match(/[àèéìòù]/gi) ?? []).length
  const english = (text.match(ENGLISH) ?? []).length
  if (italian + english < MIN_WORDS) return 'unknown'
  if (italian >= english * 1.15) return 'it'
  if (english >= italian * 1.15) return 'en'
  return 'unknown'
}

/** The language the interface asked for, when this check can judge it. */
function wantedLanguage(language: string | undefined): ReplyLanguage | undefined {
  const code = (language ?? '').slice(0, 2).toLowerCase()
  return code === 'it' || code === 'en' ? code : undefined
}

/**
 * Whether one reply has to be written again in the interface's language.
 *
 * A reply the check cannot place is kept: rewriting a good answer on a guess
 * is worse than the occasional sentence in the wrong language.
 * @param reply - what the model wrote.
 * @param language - the interface's language (`x-app-language`).
 * @returns true when the reply is clearly in another language.
 */
export function replyNeedsRewrite(reply: string, language: string | undefined): boolean {
  const wanted = wantedLanguage(language)
  if (wanted === undefined) return false
  const seen = languageOfReply(reply)
  return seen !== 'unknown' && seen !== wanted
}

/**
 * The one message that asks for the reply again, in the interface's language.
 * It carries no tools: this is a rewrite, not another turn.
 * @param language - the interface's language.
 * @returns the instruction to append after the reply.
 */
export function rewriteAsk(language: string | undefined): string {
  return `Rewrite your last reply in ${languageName(language)}, and only in ${languageName(language)}. ` +
    'Keep exactly the facts, the numbers and the file names it already states; add nothing, remove nothing, and do not call a tool. ' +
    'Answer with the rewritten text alone.'
}
