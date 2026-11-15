/**
 * The comment passes: at the comment hours (three a day by default) the account's recent comments are
 * read, the warm ones liked, and a few answered with replies the text model
 * writes under the account's rules. `…/social/comments` shows the record and
 * lets the owner like, reply or run a pass by hand.
 * @module social/comments
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { readJsonFile } from '../../../server/vendor/atomic-write/index.ts'
import { message } from '../../../server/src/messages.ts'
import { readObject, sendJson } from '../../../server/src/route-kit.ts'
import {
  askModel, currentRoutes, isDryRun, log, notify, readRecent, recordFile, rememberRecent, routeCollection, socialSettings, stateDir,
} from './context.ts'
import type { SocialComment, SocialCommentPass } from '../../../shared/social-types.ts'
import { commentsAttention } from './notify.ts'
import { reconcilePermalinks } from './posts.ts'
import { readTokenState } from './token.ts'
import { COMMENT_SCRIPT, execPython, TIMEOUTS, type ScriptResult } from './python.ts'

/**
 * The account whose replies these are.
 *
 * Used to recognise our own voice in a thread: a comment naming us is somebody
 * answering a reply we already sent, and answering it again is how two bots
 * end up talking to each other.
 */
let ownUsername = ''

/** The account's username as the token settings record it (empty until set). */
async function readOwnUsername(): Promise<string> {
  try {
    return (await readTokenState()).username?.trim().replace(/^@/, '') ?? ''
  } catch {
    return ''
  }
}
/** Where the record of every handled comment lives. */
/** The comment record and the ring of replies already written. */
const commentsPath = (): string => join(stateDir(), 'comments.json')
/**
 * The replies already sent, so the next ones read differently.
 *
 * Separate from the captions: a caption is written once per post and a reply
 * many times a day, and the whole point of keeping them is that a stream of
 * "Grazie mille ✨" under every comment is what gives an account away.
 */
const recentRepliesPath = (): string => join(stateDir(), 'recent-replies.json')
/**
 * The hours a pass runs, local time: the `commentHours` setting (8, 14 and
 * 20 by default).
 *
 * Comments arrive all day but answering them within the hour reads as a bot
 * watching the notifications; three passes is a profile checking in.
 */
const commentHours = (): readonly number[] => socialSettings().commentHours()
/**
 * At most one reply per author per pass.
 *
 * The single most damaging failure here is not a wrong answer, it is two
 * answers: the same person leaves five variations of the same compliment
 * under one post, and replying to each turns the thread into a conversation
 * with ourselves. One reply per person, per pass.
 */
const MAX_REPLIES_PER_AUTHOR = 1
/**
 * A ceiling on how many replies one pass may send.
 *
 * Not a rate limit from Meta — a blast radius. If the model misreads the batch
 * or the duplicate guard fails, the damage stops at six public replies rather
 * than at however many comments happened to be waiting.
 */
const MAX_REPLIES_PER_PASS = 6
/** How many handled comments the record keeps before dropping the oldest. */
const COMMENTS_KEEP = 500
/** Comments that are only emoji: like them, never reply. */
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s❤️]+$/u

/** One comment as the script reports it. */
interface SeenComment {
  readonly id: string
  readonly text?: string
  readonly author_label?: string
  readonly username?: string
  readonly timestamp?: string
  readonly media_id?: string
  readonly permalink?: string
  readonly media_caption?: string
  readonly classification?: string
}

/** A record the plugin fills in as it goes: the shared wire type, writable here. */
type Writable<T> = { -readonly [K in keyof T]: T[K] }

/** One handled comment, as `comments.json` and the page keep it (`SocialComment`). */
type CommentEntry = Writable<SocialComment>

/** What one pass did (`SocialCommentPass`). */
type PassCounters = Writable<SocialCommentPass>

/**
 * The record, held in memory and written through, like the queue.
 *
 * This is what the page shows; the script keeps its own state file for the
 * duplicate guard. Two files because they answer different questions: ours is
 * "what happened", the script's is "has this comment already been handled",
 * and the second must stay true even if the first is deleted.
 */
let comments: CommentEntry[] | undefined
/** State that outlives a pass: when the last one ran, and what it said. */
let commentsMeta: { lastRunAt?: string; lastError?: string; lastCounters?: unknown } = {}
/** The ids the last pass read, for the owner's notice after a scheduled pass. */
let lastPassIds: readonly string[] = []
const commentsFile = recordFile(commentsPath, 'comments', () => ({ ...commentsMeta, comments: (comments ?? []).slice(-COMMENTS_KEEP) }))

/**
 * Read the comment record from disk once, then serve it from memory.
 * @returns the handled comments, oldest first.
 */
async function loadComments(): Promise<CommentEntry[]> {
  if (comments !== undefined) return comments
  const parsed = await readJsonFile(commentsPath()) as { comments?: unknown; lastRunAt?: unknown; lastError?: unknown; lastCounters?: unknown } | null | undefined
  if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.comments)) {
    comments = parsed.comments.filter((entry): entry is CommentEntry =>
      entry !== null && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string')
    commentsMeta = {
      lastRunAt: typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : undefined,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : undefined,
      lastCounters: parsed.lastCounters,
    }
  } else {
    comments = []
  }
  return comments
}

/**
 * Find or create the record for one comment.
 * @param seen - the comment as the script reported it.
 * @returns the stored record, updated with what the script just saw.
 */
async function rememberComment(seen: SeenComment): Promise<CommentEntry> {
  const list = await loadComments()
  let entry = list.find(comment => comment.id === seen.id)
  if (entry === undefined) {
    entry = { id: seen.id, seenAt: new Date().toISOString() }
    list.push(entry)
  }
  entry.text = seen.text ?? entry.text
  entry.author = seen.author_label ?? entry.author
  entry.username = seen.username ?? entry.username
  entry.timestamp = seen.timestamp ?? entry.timestamp
  entry.mediaId = seen.media_id ?? entry.mediaId
  entry.permalink = seen.permalink ?? entry.permalink
  entry.mediaCaption = seen.media_caption ?? entry.mediaCaption
  entry.classification = seen.classification ?? entry.classification
  return entry
}

/**
 * The reason a like failed, in words the owner can act on.
 *
 * Meta's transient "#2 Internal Server Error" reached the page as a Python
 * wrapper, so a provider-side glitch read like our bug. It is not: every like
 * on 2026-10-20 got the same answer with three different tokens, while reading
 * the comment kept working — so it is Meta, not the account, not the code.
 * @param result - the parsed answer of `--like`, or the caught error message.
 * @returns one line to store as `likeError`.
 */
function likeFailureReason(result: ScriptResult | string): string {
  const stated = typeof result === 'string' ? result : String(result?.error ?? result?.reason ?? message('social.likeRefused'))
  if (/HTTP 500[^]*#2[^]*Internal Server Error/.test(stated) || /is_transient/.test(stated)) {
    return message('social.likeTransient')
  }
  if (/already_liked/.test(stated)) return message('social.alreadyLiked')
  return stated
}

/**
 * Like one comment through the script and record the outcome on its entry.
 *
 * Shared by the pass and the page's own button. The script reads the count
 * back and says whether the like can be seen (`likeSeen`), kept but never
 * acted on: Meta answers success either way.
 * @param entry - the stored comment, updated in place.
 * @returns "sent" for a new like, "kept" for one Meta already had, "failed".
 */
async function likeComment(entry: CommentEntry): Promise<'sent' | 'kept' | 'failed'> {
  try {
    const result = await execPython(COMMENT_SCRIPT(), ['--like', entry.id, '--json'], TIMEOUTS.commentAction)
    if (result?.ok === true) {
      entry.liked = true
      entry.likedAt = new Date().toISOString()
      entry.likeError = undefined
      entry.likePending = undefined
      entry.likeSeen = typeof result.seen === 'boolean' ? result.seen : undefined
      return result.sent === true ? 'sent' : 'kept'
    }
    entry.likeError = likeFailureReason(result)
  } catch (error: unknown) {
    entry.likeError = likeFailureReason(error instanceof Error ? error.message : String(error))
  }
  return 'failed'
}

/**
 * Reply to one comment through the script and record the outcome on its entry.
 * @param entry - the stored comment, updated in place.
 * @param text - the reply.
 * @returns "sent", "kept" when the script found a reply already live (its
 * duplicate guard, not an error), or "failed".
 */
async function replyToComment(entry: CommentEntry, text: string): Promise<'sent' | 'kept' | 'failed'> {
  try {
    const result = await execPython(COMMENT_SCRIPT(), ['--reply', entry.id, text, '--json'], TIMEOUTS.commentAction)
    if (result?.ok === true && result.sent === true) {
      entry.replied = true
      entry.replyText = text
      entry.repliedAt = new Date().toISOString()
      entry.replyError = undefined
      entry.proposedReply = undefined
      await rememberRecent(recentRepliesPath(), text, 'reply')
      return 'sent'
    }
    if (result?.ok === true) {
      entry.replied = true
      entry.skipReason = String(result.reason ?? message('social.alreadyReplied'))
      return 'kept'
    }
    entry.replyError = String(result?.error ?? message('social.replyRefused'))
  } catch (error: unknown) {
    entry.replyError = error instanceof Error ? error.message : String(error)
  }
  return 'failed'
}

/**
 * Why the model wrote nothing, worded so the comment page can show it.
 *
 * `no model` alone was ambiguous: on 2026-10-20 the pass logged
 * "no model, replies skipped" while the route was configured and the
 * provider was answering, so the note pointed at the wrong thing.
 * @returns one sentence naming what is actually missing or slow.
 */
function noModelReason(): string {
  const target = currentRoutes().text
  if (target === undefined) return message('social.noTextModel')
  return message('social.modelWroteNothing', { model: `${target.provider}/${target.model}` })
}

/**
 * The rules the replies are written under.
 *
 * Carried over from the account's earlier publisher almost word for word, because they were
 * not written in the abstract: each line is a mistake that went out publicly
 * once. The romantic register in particular — the account attracts a stream of
 * "amore mio", and answering in kind reads as encouragement rather than
 * politeness.
 * @param batch - the comments to decide on.
 * @param recent - replies already sent, which must not come back.
 * @returns the instruction text.
 */
function replyInstruction(batch: readonly SeenComment[], recent: readonly string[]): string {
  const items = batch.map(comment => [
    `#${comment.id}`,
    // The script's names: until 2026-10-25 this read `author`/`mediaCaption`,
    // which it never sends, and every comment went out as «sconosciuto» under «-».
    `autore: ${comment.author_label ?? (comment.username === undefined ? 'sconosciuto' : `@${comment.username}`)}`,
    `sotto il post: ${(comment.media_caption ?? '').split('\n')[0]?.slice(0, 120) || '-'}`,
    `commento: ${(comment.text ?? '').replace(/\s+/g, ' ').slice(0, 400)}`,
  ].join('\n')).join('\n\n')
  const avoid = recent.length > 0 ? `\n\nRisposte già mandate di recente. Non ripeterle, nemmeno riformulate:\n${recent.map(reply => `- ${reply}`).join('\n')}` : ''
  return `Gestisci le risposte ai commenti del profilo Instagram${ownUsername === '' ? '' : ` @${ownUsername}`}. Ti do i commenti a cui nessuno ha ancora risposto: per ognuno decidi se rispondere e cosa scrivere.

COME SI RISPONDE
- Tono cordiale ma misurato, da profilo pubblico. Una o due righe, emoji con parsimonia.
- Pertinente a quello che la persona ha scritto: se fa un complimento al look, parla del look; se fa una domanda a cui il post risponde, rispondi.
- Ogni risposta diversa dalle altre di questo elenco e da quelle già mandate.

MAI
- Toni romantici o affettuosi: niente "amore", "anche io", "ricambio", niente cuori ❤️ 💕. Alla dichiarazione d'amore si risponde con un ringraziamento asciutto, o non si risponde.
- Niente confidenza, niente promesse, niente rimandi ai messaggi privati.
- Niente risposte a commenti volgari, sessuali o polemici: si saltano, non si litiga.
- Niente risposte a chi sta continuando una conversazione (dice "prego", "di nulla", "figurati", o riprende un nostro ringraziamento).

LINGUA
Italiano, salvo che il commento sia chiaramente in inglese, spagnolo, francese o portoghese: in quel caso rispondi in quella lingua. Se è in un'altra lingua ancora, salta.

QUANDO RISPOSTA
Un complimento, un complimento sul look o sulla musica, un saluto o un "sei fantastica" ricevono una risposta breve e cordiale: è il caso più comune e lasciare tutti senza risposta sembra indifferenza. Esempi di quello che va bene: "Grazie, felice che ti piaccia!" oppure "Grazie del complimento!".

QUANDO SALTARE
Salta se il commento è solo emoji, se non dice niente a cui si possa rispondere, se non capisci cosa intende, se è la stessa persona di un altro commento qui sotto, se il commento è una dichiarazione d'amore o ha toni sessuali, volgari o polemici. Una risposta maldestra resta pubblica.

I COMMENTI

${items}${avoid}

Rispondi SOLO con una riga per commento, niente altro, niente ragionamento, nell'ordine in cui te li ho dati:
#id | il testo della risposta
oppure, per saltarlo:
#id | -`
}

/**
 * Read the model's decisions back out.
 * @param written - the model's reply.
 * @param batch - the comments it was asked about.
 * @returns the reply text for each comment id that got one.
 */
function readReplies(written: string, batch: readonly SeenComment[]): Map<string, string> {
  const known = new Set(batch.map(comment => comment.id))
  const out = new Map<string, string>()
  for (const line of written.split('\n')) {
    const match = /^\s*#?(\d{5,})\s*[|:]\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    const [, id = '', text = ''] = match
    if (!known.has(id) || out.has(id)) continue
    const reply = text.trim().replace(/^["']|["']$/g, '')
    // A dash is the model saying "skip", which it does often and should.
    if (reply === '' || reply === '-' || reply.length > 300) continue
    out.set(id, reply)
  }
  return out
}

/**
 * Which comments this pass may answer.
 *
 * The model is asked to group by person and skip repeats, but this is not left
 * to it: a batch is capped per author and overall in code first, so a
 * misreading cannot turn into a run of replies.
 * @param seen - everything the script reported as unhandled.
 * @returns the comments worth asking the model about.
 */
function replyCandidates(seen: readonly SeenComment[]): SeenComment[] {
  const perAuthor = new Map<string, number>()
  const out: SeenComment[] = []
  for (const comment of seen) {
    const text = (comment.text ?? '').trim()
    if (text === '') continue
    // Answering a comment that names us continues our own thread. The script
    // marks these handled too; repeated here because it is the rule that
    // matters most and it costs one line.
    if (ownUsername !== '' && text.toLowerCase().includes(ownUsername.toLowerCase())) continue
    if (EMOJI_ONLY.test(text)) continue
    if (comment.classification === 'offensive' || comment.classification === 'spam') continue
    const author = comment.username ?? comment.author_label ?? comment.id
    const already = perAuthor.get(author) ?? 0
    if (already >= MAX_REPLIES_PER_AUTHOR) continue
    perAuthor.set(author, already + 1)
    out.push(comment)
    if (out.length >= MAX_REPLIES_PER_PASS) break
  }
  return out
}

/**
 * Read, like and reply once over the account's recent comments.
 *
 * Never throws: the scheduler calls it unattended, so a failure has to end up
 * readable in the record rather than as an unhandled rejection.
 * @param dryRun - work out the replies but send nothing.
 * @returns what the pass did.
 */
async function runCommentPass(dryRun = false): Promise<unknown> {
  ownUsername = await readOwnUsername()
  const counters: PassCounters = { read: 0, liked: 0, replied: 0, flagged: 0, skipped: 0, linked: 0, errors: 0, likePending: 0, dryRun }
  // Loaded first, as every pass did through rememberComment: a pass that
  // fails to read must not write a record that forgot the comments on disk.
  await loadComments()
  commentsMeta.lastRunAt = new Date().toISOString()
  commentsMeta.lastError = undefined
  lastPassIds = []
  let seen: SeenComment[] = []
  try {
    const result = await execPython(COMMENT_SCRIPT(), ['--readonly', '--json'], TIMEOUTS.comments)
    seen = Array.isArray(result?.comments) ? result.comments as SeenComment[] : []
  } catch (error: unknown) {
    commentsMeta.lastError = error instanceof Error ? error.message : String(error)
    commentsMeta.lastCounters = { ...counters, errors: 1 }
    log(`comment pass could not read: ${String(commentsMeta.lastError)}`)
    await commentsFile.save()
    return commentsMeta.lastCounters
  }
  counters.read = seen.length
  lastPassIds = seen.map(comment => comment.id)
  counters.linked = await reconcilePermalinks(seen)
  for (const comment of seen) {
    const entry = await rememberComment(comment)
    // Offensive comments are recorded and shown, never removed: hiding or
    // deleting is the account owner's call, and the record is what lets
    // them make it.
    if (comment.classification === 'offensive') {
      entry.flagged = true
      counters.flagged += 1
    }
  }
  // Likes first, and on their own terms: a like is reversible and says
  // nothing, so it goes on every warm comment including the emoji-only ones
  // that must never get a written reply.
  //
  // The script reads the count back afterwards and says whether the like can
  // actually be seen, because Meta answers success either way. That answer is
  // kept next to the like and never acted on: it is one comment's count, and
  // a stranger liking at the same second reads the same as a confirmation.
  for (const comment of seen) {
    if (comment.classification !== 'positive' && comment.classification !== 'question') continue
    const entry = await rememberComment(comment)
    if (entry.liked === true) continue
    if (dryRun) {
      counters.liked += 1
      continue
    }
    const outcome = await likeComment(entry)
    if (outcome === 'sent') counters.liked += 1
    else if (outcome === 'failed') counters.errors += 1
  }
  /*
   * Meta answering the same refusal to every like is one fact about the
   * account, not twelve errors. On 2026-10-20 the summary said "17 errori"
   * for one cause ("#2 Internal Server Error", is_transient) and the page
   * showed a raw error per comment, so the number grew with the queue while
   * nothing new was wrong. The note stays on each comment; the count keeps
   * only failures that are not the same refusal repeated.
   */
  const likeFailures = new Map<string, number>()
  for (const comment of seen) {
    const recorded = await rememberComment(comment)
    const problem = recorded.likeError
    if (typeof problem !== 'string' || problem === '') continue
    likeFailures.set(problem, (likeFailures.get(problem) ?? 0) + 1)
  }
  /*
   * A refusal that Meta repeats on every comment is a condition of the
   * account, not one error per comment: those likes move to pending, the
   * page shows one line instead of a red error on each comment, and the
   * next pass tries again. A failure that happens once stays an error.
   */
  const list = await loadComments()
  for (const [problem, n] of likeFailures) {
    if (n < 2) continue
    counters.errors = Math.max(0, counters.errors - (n - 1))
    counters.likePending += n
    for (const recorded of list) {
      if (recorded.likeError !== problem) continue
      recorded.likePending = true
      recorded.likeError = undefined
    }
    log(`like in attesa (${String(n)} commenti): ${problem.slice(0, 200)}`)
  }
  const batch = replyCandidates(seen)
  counters.skipped = seen.length - batch.length
  if (batch.length > 0) {
    const recent = await readRecent(recentRepliesPath(), 12)
    const written = await askModel(replyInstruction(batch, recent), TIMEOUTS.comments)
    if (written === undefined) {
      // No model, no replies. The alternative — a canned "grazie mille" —
      // is exactly the thing the rules above exist to prevent, so a pass
      // with the model down likes and says nothing.
      commentsMeta.lastError = noModelReason()
      log(`comment pass: no reply written for ${String(batch.length)} comments — ${String(commentsMeta.lastError)}`)
    } else {
      const decided = readReplies(written, batch)
      for (const comment of batch) {
        const entry = await rememberComment(comment)
        const reply = decided.get(comment.id)
        if (reply === undefined) {
          entry.skipReason = message('social.modelSkipped')
          continue
        }
        if (dryRun) {
          entry.proposedReply = reply
          counters.replied += 1
          continue
        }
        const outcome = await replyToComment(entry, reply)
        if (outcome === 'sent') counters.replied += 1
        else if (outcome === 'failed') counters.errors += 1
      }
    }
  }
  commentsMeta.lastCounters = counters
  await commentsFile.save()
  log(`comment pass: ${JSON.stringify(counters)}`)
  return counters
}

/**
 * Run a pass when one of the comment hours comes round.
 *
 * Called from the same tick as the publisher rather than on a timer of its
 * own: the hour is the schedule, and the record of the last run is what keeps
 * thirty-second ticks inside that hour from running it again.
 */
export async function runDueCommentPass(): Promise<void> {
  const now = new Date()
  if (!commentHours().includes(now.getHours())) return
  await loadComments()
  if (commentsMeta.lastRunAt !== undefined) {
    const last = new Date(commentsMeta.lastRunAt)
    if (last.getHours() === now.getHours() && last.toDateString() === now.toDateString()) return
  }
  log(`comment pass due at ${String(now.getHours())}:00`)
  await runCommentPass()
  await tellOwner()
}

/**
 * After a scheduled pass, the comments that need the owner, once each.
 *
 * Only after the scheduled passes: a pass run by hand is in front of the
 * person who ran it. A comment named once is marked `toldOwner` and never
 * named again, even if it stays unanswered.
 */
async function tellOwner(): Promise<void> {
  const ids = new Set(lastPassIds)
  const list = await loadComments()
  const attention = commentsAttention(list.filter(entry => ids.has(entry.id)), commentsMeta.lastError)
  if (attention === undefined) return
  const told = new Set(attention.ids)
  for (const entry of list) if (told.has(entry.id)) entry.toldOwner = true
  await commentsFile.save()
  await notify(attention.text)
}

/**
 * Handle the …/social/comments routes.
 *
 * GET  /comments               what has been handled, newest first
 * POST /comments/run           run a pass now (`?dry=1` to decide but not send)
 * POST /comments/<id>/like     like one comment by hand
 * POST /comments/<id>/reply    reply to one comment by hand
 * @param req - incoming request.
 * @param res - server response.
 * @param subpath - the path under /social.
 */
export async function handleComments(req: IncomingMessage, res: ServerResponse, subpath: string): Promise<void> {
  const list = await loadComments()
  await routeCollection<CommentEntry>(req, res, subpath, '/comments', {
    notFound: message('social.commentNotFound'),
    find: async id => list.find(comment => comment.id === id),
    list: async () => {
      sendJson(res, 200, {
        ok: true,
        comments: [...list].reverse(),
        lastRunAt: commentsMeta.lastRunAt ?? null,
        lastError: commentsMeta.lastError ?? null,
        lastCounters: commentsMeta.lastCounters ?? null,
        hours: commentHours(),
      })
    },
    special: {
      'POST run': async () => { sendJson(res, 200, { ok: true, counters: await runCommentPass(isDryRun(req)) }) },
    },
    actions: {
      'POST like': async (_req, _res, entry) => {
        await likeComment(entry)
        await commentsFile.save()
        sendJson(res, entry.likeError === undefined ? 200 : 500, { ok: entry.likeError === undefined, comment: entry })
      },
      'POST reply': async (_req, _res, entry) => {
        const body = await readObject(req)
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '') return sendJson(res, 400, { error: message('social.replyTextRequired') })
        await replyToComment(entry, text)
        await commentsFile.save()
        sendJson(res, entry.replyError === undefined ? 200 : 500, { ok: entry.replyError === undefined, comment: entry })
      },
    },
  })
}
