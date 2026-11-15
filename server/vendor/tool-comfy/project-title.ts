/**
 * Naming an Imagine project from its first content.
 *
 * The studio used to name a project with whatever the user typed, truncated:
 * a rail of "genera una foto di Ciri in armat…" entries. The reading model
 * that already reads every written line can do better — and the composer lane
 * (which never reads anything at all) gets a name for the projects it mints.
 * The call is short and bounded, and a name that never comes back is not a
 * failure: the project keeps the provisional name and the next content asks
 * again.
 * @module tool-comfy/project-title
 */

import type { ImagineHost } from '../../src/host.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'
import { languageName } from '../../../shared/locale-names.ts'
import { fencedBody } from './model-json.ts'
import { firstTextReply } from './text-pass.ts'

/** How long a title may wait for: longer and the provisional name wins. */
const TITLE_TIMEOUT_MS = 30_000

/** Most content a title instruction may carry: a song's whole lyrics are not a title. */
const TITLE_SOURCE_CHARS = 500

/** Most characters a finished name may hold, whatever the model wrote. */
const TITLE_MAX_CHARS = 40

/**
 * The instruction that turns one piece of content into a project name.
 * @param source - the content the project will hold.
 * @returns the prompt sent to the reading model.
 */
function titleInstruction(source: string, language?: string): string {
  const text = source.replace(/\s+/g, ' ').trim().slice(0, TITLE_SOURCE_CHARS)
  /*
   * The interface decides the language, not the written text: someone using
   * the studio in English who dictates an Italian sentence wants an English
   * name. Without the hint it stays on "the user's language", which is the
   * previous behaviour.
   */
  const wanted = language === undefined || language === ''
    ? "in the user's language"
    : `in ${languageName(language)}`
  return `The Imagine studio is creating a project that will hold this content:
"""
${text}
"""
Give the project a short name (2-5 words, ${wanted}) that says what it is about: no quotes, no full stop at the end, no "photo of" or "generation of".
Reply ONLY with the name.`
}

/**
 * Clean one model reply into a name.
 *
 * The model is told to answer with the name alone, but it may still wrap it
 * in a fence, quote it, or pad it with a sentence. A name with punctuation
 * around it is cleaned; a reply that has no name in it is no name at all.
 * @param text - the raw reply.
 * @returns the name, or undefined when the reply holds none.
 */
function cleanTitle(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const body = fencedBody(text) ?? text
  const line = body.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? ''
  let name = line
    .replace(/^[\s"'“”«]+|[\s"'”»]+$/g, '')
    .replace(/^["']|["']$/g, '')
    .replace(/[.!?。]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // A name that is still a whole sentence is not a name: the model narrated
  // instead of answering, and the narration is the provisional title back
  // again, longer and worse. Checked before the length cap, which would cut
  // the sentence short and make it pass as a name.
  if (name.length === 0) return undefined
  if (name.split(' ').length > 8) return undefined
  if (name.length > TITLE_MAX_CHARS) name = name.slice(0, TITLE_MAX_CHARS).trimEnd()
  return name.length === 0 ? undefined : name
}

/**
 * Ask the reading model for a short project name.
 *
 * Tries the same routes the chat reading does, in the same order, and never
 * throws: the callers fire the ask without waiting for it, and a title that
 * fails costs a keep of the provisional name, not a broken turn.
 * @param ctx - plugin context, carrying `auxiliary` and `llm` when set up.
 * @param source - the content the project will hold.
 * @param chosen - the model the studio is showing, when the caller has one.
 * @returns the name, or undefined when nothing readable came back.
 */
export async function readProjectTitle(
  ctx: ImagineHost,
  source: string,
  chosen?: ModelRoute,
  language?: string,
): Promise<string | undefined> {
  return firstTextReply(ctx, chosen, titleInstruction(source, language), TITLE_TIMEOUT_MS, cleanTitle, 'the project title')
}
