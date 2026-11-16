/**
 * The score MiniMax Music 3 is actually asking for, written from one line.
 *
 * The graph takes two texts and the studio was sending neither in the form the
 * model reads. Its own template says so: the **caption** is a structured
 * description in three sections — Global Metadata, Vocal Details, Arrangement —
 * and the **lyrics** carry `[Intro]` `[Verse]` `[Chorus]` `[Bridge]` `[Outro]`
 * tags, which are *"the only executable structural instructions; the lyric text
 * itself only conveys mood"*. A one-line caption ("K-pop sensual love song,
 * female vocals") with an untagged block of words is a song with no structure
 * to follow and a style the model has to guess, and it sounds like one.
 *
 * This module writes both with the text model, on the same terms as the video
 * prompt: the user's line decides what the song is, the model only puts it in
 * the shape the sampler reads, and anything that goes wrong leaves the plain
 * line — a weaker song, not a failed run.
 * @module tool-comfy/music-prompt
 */


import type { ImagineHost } from '../../src/host.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'
import { jsonObjectOf } from './model-json.ts'
import { firstTextReply } from './text-pass.ts'
import { textField } from './guards.ts'
import type { MusicClipRequest } from '../../../shared/imagine-types.ts'

/**
 * New words a tagging pass may add before the sheet counts as invented.
 *
 * A few interjections are the model punctuating a chorus; a verse is dozens.
 */
const ADDED_WORDS = 4

/** …or this share of the user's own words, whichever is larger. */
const ADDED_SHARE = 0.05

/** Longest caption accepted; past this the model is writing liner notes. */
const MAX_CAPTION_LENGTH = 4000

/** Longest lyric sheet accepted, tags included. */
const MAX_LYRICS_LENGTH = 8000

/**
 * How much of the user's words the tagged lyrics must still contain.
 *
 * The model is asked to add tags and nothing else, and a model that rewrites
 * the song instead has to be caught: the words are the one thing the user
 * wrote by hand. Below this share of them the tagged sheet is dropped and the
 * original goes to the sampler untagged.
 */
const KEPT_WORDS = 0.8

/** The two texts the music graph takes. */
export interface MusicScore {
  /** The caption: Global Metadata, Vocal Details, Arrangement. */
  readonly caption: string
  /** The lyrics with their section tags, or empty for an instrumental. */
  readonly lyrics: string
  /**
   * How long the song should be, decided from the words, when nobody said.
   *
   * Three fixed lengths were on offer (60, 120, 180) and none of them is the
   * length of a given lyric sheet: a two-verse song at 180 s is two minutes
   * of padding. The writer that structures the words is the one that knows
   * how long they take to sing.
   */
  readonly seconds?: number
}

/** The shortest and longest song the writer may decide on, in seconds. */
const MUSIC_MIN_SECONDS = 30
const MUSIC_MAX_SECONDS = 300

/**
 * The instruction that turns one line into a caption and a tagged lyric sheet.
 * @param line - what the user asked for, in their own words.
 * @param lyrics - the words to sing, empty for an instrumental.
 * @param seconds - the length the song is generated at; absent, the writer decides it from the words.
 * @returns the prompt sent to the writing model.
 */
function musicScoreInstruction(line: string, lyrics: string, seconds?: number): string {
  const sung = lyrics.trim()
  return `Write the two texts the MiniMax Music 3 music model takes as input${seconds === undefined ? ', and decide how long the track should be' : `, for a track of about ${String(Math.round(seconds))} seconds`}.

The user asked for: "${line}"

${sung.length === 0
  ? 'There are no words to sing: this is an instrumental track, and "lyrics" stays empty.'
  : `Words to sing (they are the user's: do NOT change them, do not translate them, do not add any, do not drop any):
"""
${sung}
"""`}

Reply ONLY with a JSON object:
{"caption": "<the musical description>", "lyrics": "<the words with their structure tags>"${seconds === undefined ? ', "seconds": <duration in seconds, whole number>' : ''}}
${seconds === undefined
  ? `
How to decide "seconds": the duration needed to sing ALL the words at a normal pace for the genre (roughly 2-3 words per second, more in rap), plus a short intro and outro and the instrumental parts you placed between sections, PLUS 5-10 seconds of margin. A whole number between ${String(MUSIC_MIN_SECONDS)} and ${String(MUSIC_MAX_SECONDS)}: a few lines are 40-60 seconds, a song with verses and a chorus 90-180, a long piece up to 240-300. The margin is needed because "seconds" is a CEILING: if the model does not close on its own, the code cuts hard there and the last sung line disappears. Do not round to 60/120/180. With no words, 60.
`
  : ''}
How to write "caption" (in English, three sections, each one a paragraph):
Global Metadata: genre and subgenre, BPM, key, mood from the first bar to the last, listening context, how the production sounds (texture, mix, effects).
Vocal Details: which voice sings (timbre, register, sex, technique), how it pronounces the phrases, backing vocals and harmonies, how far forward or back it sits in the mix. DICTION: always ask for CLEAR pronunciation, every word understandable, the lyric intelligible ("emphasizing lyrical clarity", "prioritizing clarity"): do NOT ask for whispered, mumbled or "breathy" lines, because a whisper eats the consonants and the words stop being understood (measured: 92% of words recognisable against 98%+ with diction stated).
Arrangement: the instruments and what each one does, and then section by section (intro, verses, choruses, instrumentals, bridge, outro) what comes in and what drops out.
Be specific and concrete: the more precise it is, the closer the track matches the request. No empty words ("beautiful", "epic") and no real artist names.

How to write "lyrics"${sung.length === 0 ? ' (empty: instrumental track)' : ''}:
${sung.length === 0
  ? '- empty string.'
  : `- the user's exact same words, in the same order and in their own language;
- add ONLY the section tags on a line of their own: [Intro] [Verse] [Pre-Chorus] [Chorus] [Post-Chorus] [Bridge] [Instrumental] [Solo] [Outro];
- break the line where a verse ends, and put [Chorus] on the chorus (the part that repeats, or the part the user repeats);
- the tags are the only thing that decides the structure of the track: without them the model sings one single stream;
- you may repeat a block that is already there (a chorus that comes back) and you may put [Instrumental] between two parts, but you may not invent new lines.`}`
}

/** The words of a lyric sheet, lowercased, with tags and punctuation dropped. */
function wordsOf(text: string): readonly string[] {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(word => word.length > 0)
}

/**
 * Whether a tagged sheet still sings the words the user wrote, and only those.
 *
 * Counted per word rather than per line: the model is allowed to repeat a
 * chorus and to break lines differently, and neither changes which words are
 * sung. A sheet that lost a fifth of them is a rewrite, not a tagging.
 *
 * Both directions, because only checking that the user's words survived let a
 * model append a whole invented verse and pass: the song then sang lines the
 * user never wrote, which is what they heard. Words that appear only in the
 * sheet are the invention, and a handful of them — an "oh", a "yeah" — is the
 * most a tagging pass should add.
 * @param original - the user's words.
 * @param tagged - what the model answered.
 * @returns true when the user's words survive and the sheet added no verse.
 */
function keepsTheWords(original: string, tagged: string): boolean {
  const wanted = wordsOf(original)
  if (wanted.length === 0) return true
  const written = wordsOf(tagged)
  const got = new Set(written)
  const kept = wanted.filter(word => got.has(word)).length
  if (kept / wanted.length < KEPT_WORDS) return false
  const mine = new Set(wanted)
  const added = new Set(written.filter(word => !mine.has(word)))
  return added.size <= Math.max(ADDED_WORDS, Math.round(wanted.length * ADDED_SHARE))
}

/** Which voice the studio asked to sing. */
export type Singer = MusicClipRequest['voice']

/**
 * Make the caption state the voice the user chose.
 *
 * The gender travels inside the user's own line ("k-pop sensuale, voce
 * femminile") and a model then rewrites everything in English: it can drop the
 * word, or write the voice the genre suggests instead of the one that was
 * asked for, and the studio's Voce field silently does nothing. MiniMax Music
 * only knows what the caption says, so this checks the written caption and
 * states it when it is missing or wrong.
 * @param caption - the caption the model wrote.
 * @param singer - the voice the form asked for.
 * @returns the caption, guaranteed to name that voice.
 */
function withSinger(caption: string, singer: Singer | undefined): string {
  if (singer === undefined) return caption
  const wanted = singer === 'male' ? 'male' : 'female'
  const other = singer === 'male' ? 'female' : 'male'
  const said = new RegExp(`\\b${wanted}\\b`, 'i').test(caption)
  const contradicted = new RegExp(`\\b${other}\\b`, 'i').test(caption)
  if (said && !contradicted) return caption
  const stated = `${wanted === 'male' ? 'Male' : 'Female'} lead vocal.`
  // Stated first: the caption is read as a whole, and a correction buried at
  // the end argues with three paragraphs of description written before it.
  return `${stated} ${caption.replace(new RegExp(`\\b${other}\\b`, 'gi'), wanted)}`
}

/**
 * Read the caption and the lyric sheet out of the model's reply.
 * @param text - the raw reply.
 * @param lyrics - the user's own words, kept when the sheet rewrote them.
 * @returns the score, or undefined when no caption came back.
 */
function parseMusicScore(text: string | undefined, lyrics: string): MusicScore | undefined {
  const object = jsonObjectOf(text)
  if (object === undefined) return undefined
  const caption = textField(object, 'caption')
  if (caption === undefined || caption.length > MAX_CAPTION_LENGTH) return undefined
  const written = textField(object, 'lyrics')
  const sung = lyrics.trim()
  /*
   * The words are the user's. A sheet that dropped them, or that came back
   * longer than a song, leaves the original untagged: a flat structure is a
   * worse song, a rewritten one is somebody else's.
   */
  const tagged = written === undefined || written.length > MAX_LYRICS_LENGTH || !keepsTheWords(sung, written)
    ? sung
    : written
  /*
   * A lyric sheet that was thrown away is a song without its structure tags,
   * which plays as one flat stream: said out loud because the words are the
   * user's and the loss looks like the model's choice.
   */
  const discarded = written === undefined || tagged !== sung
    ? undefined
    : written.length > MAX_LYRICS_LENGTH
      ? `too long (${String(written.length)} characters)`
      : 'it does not keep the user\'s words'
  if (discarded !== undefined) {
    console.warn(`[imagine] song: the sung text the model wrote was discarded (${discarded}), using the user's words without the structure tags`)
  }
  const seconds = object.seconds
  const decided = typeof seconds === 'number' && Number.isFinite(seconds)
    ? Math.max(MUSIC_MIN_SECONDS, Math.min(MUSIC_MAX_SECONDS, Math.round(seconds)))
    : undefined
  return { caption, lyrics: tagged, ...decided === undefined ? {} : { seconds: decided } }
}

/**
 * Write the caption and the tagged lyrics with the studio's text model.
 *
 * Never throws: no model, a slow one, or a reply in the wrong shape all leave
 * the caller with the line the user wrote, which is what the studio sent
 * before this existed.
 * @param ctx - plugin context, carrying `llm` and Imagine's own models.
 * @param line - what the user asked for.
 * @param lyrics - the words to sing, empty for an instrumental.
 * @param seconds - the length the song is generated at.
 * @param chosen - the text model the composer picked, when not the default.
 * @param singer - the voice to sing it, when one was chosen.
 * @returns the score, or undefined when it could not be written.
 */
export async function writeMusicScore(
  ctx: ImagineHost,
  line: string,
  lyrics: string,
  seconds: number | undefined,
  chosen?: ModelRoute,
  singer?: Singer,
): Promise<MusicScore | undefined> {
  /*
   * Every route in turn, not only the first.
   *
   * The studio's model chip comes first, and a model can be picked there that
   * cannot write a caption in the time a caption is worth waiting for: mimo
   * took 7.6 seconds for sixteen tokens, so a three-paragraph caption ran past
   * the timeout. The song was then generated on the user's bare sentence, with
   * no caption and no structure tags — a male voice for a female request, and
   * lyrics sung as one flat stream. Falling through to the deployment's own
   * text model costs one wait and saves the song.
   */
  const score = await firstTextReply(ctx, chosen, musicScoreInstruction(line, lyrics, seconds),
    written => parseMusicScore(written, lyrics), 'the song\'s caption')
  return score === undefined ? undefined : { ...score, caption: withSinger(score.caption, singer) }
}
