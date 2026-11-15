/**
 * POST …/social/caption-preview: the caption and hashtags of a post, written
 * in two stages — the vision model says what is in the picture, a text-only
 * call writes the post from those facts — with the templates as the fallback
 * when either stage gives nothing.
 * @module social/captions
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SEED_MESSAGE_PREFIX, type ImagineMessage, type ImagineProject } from '../../../shared/imagine-projects.ts'
import type { PostType } from '../../../shared/social-types.ts'
import { kindOf } from '../../../server/vendor/tool-comfy/gallery.ts'
import { lookWith } from '../../../server/vendor/tool-comfy/imagine-models.ts'
import { loadImagineStore } from '../../../server/vendor/tool-comfy/imagine-store.ts'
import { recallNote } from '../../../server/vendor/tool-comfy/imagine-notes.ts'
import { frameAt } from '../../../server/vendor/tool-comfy/media-tools.ts'
import { readObject, sendJson } from '../../../server/src/route-kit.ts'
import {
  askModel, currentRoutes, errorText, log, readRecent, rememberRecent, resolveMediaPath, socialHost, socialSettings, stateDir,
} from './context.ts'

/**
 * How long the vision pass may take before the templates take over.
 *
 * The backend is shared, so a shrunk image that usually answers in 7-15s can
 * still queue behind other work; abandoning it early only starts a second
 * request behind the first, and the panel already says it is waiting.
 */
const VISION_TIMEOUT = 90_000

/**
 * The longest side the vision model is given.
 *
 * The gallery writes 1080x1920 PNGs of about 2.3MB; at that size one pass took
 * around 29s and regularly ran past the budget. Fitted into 768px as a JPEG the
 * same picture is ~70KB and answers in 7-15s, with no loss the model cares
 * about at this reading distance.
 */
const VISION_MAX_SIDE = 768

/**
 * The style examples: real captions of this account, one per line of a JSON
 * list, kept in the state folder. The file name predates the plugin and is
 * kept so existing installs keep their examples.
 */
const stylePath = (): string => join(stateDir(), 'hermes-captions.json')
/** The ring of captions this deployment has already written. */
const recentPath = (): string => join(stateDir(), 'recent-captions.json')

/** How much of the generating prompt the writer sees. */
const PROMPT_KEEP = 1500
/** How many of the project's own requests the writer sees, newest last. */
const PROJECT_REQUESTS = 4

/* ----------------------------------------------------------------- hashtags */

/** The editorial policy's ceiling, reels included (Meta transcoding limit). */
const MAX_HASHTAGS = 5

/**
 * Hashtags that say nothing about the picture, so they never earn one of the
 * two dynamic slots even when the vision model offers them.
 */
const GENERIC_HASHTAGS = [
  'foto', 'photo', 'photography', 'instagram', 'instagood', 'insta', 'instadaily',
  'reel', 'reels', 'video', 'picoftheday', 'photooftheday', 'love', 'follow',
  'like', 'likeforlike', 'selfie', 'girl', 'girls', 'woman', 'women', 'ragazza',
  'donna', 'bellissima', 'beautiful', 'model', 'modella', 'outfit', 'look',
  'style', 'moda', 'fashion', 'mood', 'vibe', 'vibes', 'aesthetic', 'aesthetics',
  'urbanvibes', 'cityvibes', 'goodvibes', 'vibescheck', 'dailylook',
  // Tags about the medium rather than the subject: true of every post, so
  // they waste a slot that should say what this one shows.
  'fotografia', 'fotografiadigitale', 'digitalphotography', 'photographylovers',
  'portraitphotography', 'ritrattofotografico', 'immagine', 'scatto',
]

/**
 * Turn one word from the model's reply into a usable hashtag.
 *
 * The reply is free text, so it arrives with leading hashes, accents, quotes
 * and sometimes several words; a multi-word value becomes CamelCase the way
 * the character table already writes its tags.
 * @param raw - one token from the hashtag line.
 * @returns the normalised hashtag, or undefined when it is not usable.
 */
function sanitizeHashtag(raw: string): string | undefined {
  const stripped = raw.trim().replace(/^#+/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 _-]/g, ' ').trim()
  const parts = stripped.split(/[\s_-]+/).filter(Boolean)
  if (parts.length === 0) return undefined
  // Both #streetphotography and #StarWars are fine tags: capitalise
  // a multi-word tag only when the model already wrote it as a proper name.
  const named = parts.some(word => /^[A-Z]/.test(word))
  const joined = parts.length === 1
    ? parts[0] ?? ''
    : named ? parts.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('') : parts.join('').toLowerCase()
  if (joined.length < 4 || joined.length > 30) return undefined
  if (/^\d+$/.test(joined)) return undefined
  if (GENERIC_HASHTAGS.includes(joined.toLowerCase())) return undefined
  return `#${joined}`
}

/**
 * Read the hashtags the vision model proposed for this picture.
 * @param text - the model's reply.
 * @returns the usable hashtags, in the order given, without duplicates.
 */
function readVisionHashtags(text: string): string[] {
  const line = readVisionField(text, 'hashtag')
  if (line === undefined) return []
  const tags: string[] = []
  for (const raw of line.split(/[\s,;]+/)) {
    const tag = sanitizeHashtag(raw)
    if (tag !== undefined && !tags.some(known => known.toLowerCase() === tag.toLowerCase())) tags.push(tag)
  }
  return tags
}

/**
 * The franchise tags the context names: the first keyword of the
 * `franchiseHashtags` setting found in it (the manifest's default is the
 * table this account used).
 * @param text - the project, the facts, the prompt and the file name, joined.
 * @returns the two tags, or none.
 */
function detectCharacterHashtags(text: string): string[] {
  const lower = text.toLowerCase()
  for (const [keyword, first, second] of socialSettings().franchiseHashtags()) {
    if (lower.includes(keyword)) return [first, second]
  }
  return []
}

function generateHashtags(type: PostType, prompt: string, proposed: readonly string[] = []): string {
  // The fixed tags are the account's (settings «Hashtag fissi»), cut to the ceiling.
  const fixed = socialSettings().fixedHashtags(type).slice(0, MAX_HASHTAGS)
  const maxDyn = Math.max(0, MAX_HASHTAGS - fixed.length)
  const tags = [...fixed]
  // The keyword table goes first: when it fires it knows the franchise's
  // canonical tag, which the vision model only guesses at.
  for (const tag of [...prompt ? detectCharacterHashtags(prompt) : [], ...proposed]) {
    if (tags.length >= fixed.length + maxDyn) break
    if (!tags.some(known => known.toLowerCase() === tag.toLowerCase())) tags.push(tag)
  }
  return tags.join(' ')
}

/* ---------------------------------------------------------------- templates */

/** What the templates can mention; the preview passes none of it today. */
interface TemplateFacts {
  readonly outfit?: string
  readonly location?: string
  readonly mood?: string
}

const PHOTO_TEMPLATES: readonly ((v: TemplateFacts) => string)[] = [
  (v) => `La luce stasera era perfetta ✨ ${v.outfit || ''} ${v.location ? 'a ' + v.location : ''}`.trim(),
  (v) => `${v.mood || 'Vibe speciale'} in una serata indimenticabile 🌟 ${v.location ? '— ' + v.location : ''}`.trim(),
  (v) => `Luci, ombre e quel momento giusto ✨ ${v.outfit || ''}`.trim(),
  (v) => `Golden hour come si deve 🌅 ${v.mood || ''} ${v.location ? 'a ' + v.location : ''}`.trim(),
  (v) => `${v.outfit || 'Look del giorno'} — oggi mi sentivo così 💫`,
  (v) => `Questo outfit mi ha cambiato la giornata ✨ ${v.location || ''}`.trim(),
  (v) => `Quando il look incontra il mood giusto 🔥 ${v.mood || ''}`,
  (v) => `Non ci aspettavo che venisse così bene 🙈 ${v.outfit || ''}`,
  (v) => `Mi sono sentita in un altro mondo oggi ✨ ${v.mood || ''}`,
  (v) => `Certe serate non le scordi 🌟 ${v.location ? '— ' + v.location : ''}`.trim(),
  (v) => `Energy pura 🔥 ${v.mood || ''} ${v.outfit ? 'con ' + v.outfit : ''}`.trim(),
  (v) => `Il tipo di giornata che ti ricarica 🌸 ${v.location || ''}`.trim(),
  (v) => `Un attimo rubato al tempo. ${v.outfit || ''} ${v.location ? 'a ' + v.location : ''} ✨`.trim(),
  () => `Stasera ho deciso di uscire e guardate cosa è successo 🌟`,
  (v) => `A volte basta un momento per sentirti viva ✨ ${v.mood || ''}`,
  (v) => `Foto scattata al momento giusto — ${v.mood || 'vibe perfetto'} 📸`,
  (v) => `${v.outfit || 'Look'} 💫`,
  (v) => `${v.mood || 'Vibe'} ✨ ${v.location || ''}`.trim(),
  (v) => `${v.outfit || ''} — semplicemente così 🌟`.trim(),
  (v) => `Non ci credo nemmeno io 🙈✨ ${v.mood || ''}`,
  (v) => `Oggi mi sentivo così e basta 💃 ${v.outfit || ''}`,
  (v) => `Quando il mood è al massimo 🔥 ${v.location || ''}`.trim(),
  (v) => `Soft days, soft light 🌸 ${v.outfit || ''}`,
  (v) => `Tutto qui, tutto ora ✨ ${v.mood || ''} ${v.location ? 'a ' + v.location : ''}`.trim(),
  (v) => `Il bello delle piccole cose ✨ ${v.mood || ''}`,
]

const REEL_TEMPLATES: readonly ((v: TemplateFacts) => string)[] = [
  (v) => `Lo terresti o lo scarteresti? 🔥 ${v.mood || ''}`,
  (v) => `Meglio così o più dark? 🌙 ${v.mood || ''}`,
  (v) => `Che vibe ti dà? ✨ ${v.mood || ''}`,
  (v) => `Team neon o team fantasy? 💜 ${v.mood || ''}`,
  (v) => `Foto o Reel? 📸🎬 ${v.mood || ''}`,
  (v) => `Dammi un emoji se ti piace 🔥 ${v.mood || ''}`,
  (v) => `Cosa ne pensate? 🤔✨ ${v.mood || ''}`,
  (v) => `Replay se lo rifarei 🔄 ${v.mood || ''}`,
  (v) => `Salva per dopo 🔖 ${v.mood || ''}`,
  (v) => `Seguimi per altro contenuto così ✨ ${v.mood || ''}`,
]

function pickCaption(type: PostType, facts: TemplateFacts): string {
  const templates = type === 'reel' ? REEL_TEMPLATES : PHOTO_TEMPLATES
  const template = templates[Math.floor(Math.random() * templates.length)] ?? templates[0]
  return template === undefined ? '' : template(facts)
}

/* -------------------------------------------------------------- the replies */

/** The labels each field answers to, beyond its own name. */
const FIELD_ALIASES: Readonly<Record<string, string>> = {
  caption: 'caption|didascalia|testo',
  sottotitolo: 'sottotitolo|sotto-titolo|subtitle|sub-title',
  hashtag: 'hashtag|hashtags|tag|tags',
  franchise: 'franchise|opera|serie',
  personaggio: 'personaggio|character|char',
  elementi: 'elementi|elements|dettagli',
  sicurezza: 'sicurezza|safety|rischio',
}

/**
 * Read one labelled field out of the vision reply.
 * @param text - the model's reply.
 * @param key - the label to read.
 * @returns the value, or undefined when absent or explicitly empty.
 */
function readVisionField(text: string, key: string): string | undefined {
  // The model answers in whichever label it feels like — `hashtags:` for
  // `hashtag:`, the English `subtitle:` for `sottotitolo:` — and a label that
  // misses drops the whole line, which is how a post lost its theme tags.
  const alias = FIELD_ALIASES[key] ?? key
  const match = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?(?:${alias})(?:\\*\\*)?\\s*:\\s*(.+)$`, 'im').exec(text)
  const value = match?.[1]?.trim().replace(/^["'«]|["'»]$/g, '').trim()
  if (value === undefined || value === '' || value === '-' || /^(n\/?a|nessuno|non specificato)$/i.test(value)) return undefined
  return value
}

/** What stage one saw in the picture. */
interface SeenFacts {
  readonly franchise?: string
  readonly character?: string
  readonly elements?: string
  readonly unsafe: boolean
  readonly safety?: string
  readonly text: string
}

/** The project a file belongs to, as the writer is told about it. */
interface ProjectContext {
  readonly title: string
  /**
   * What the project is about, in the words it was described with.
   *
   * The title alone is a label ("idee-qwen", "Carabinieri 2"): the shoot's
   * subject, its theme and who is in it live in the description — the prompt
   * a project was seeded from, or the summary written in its chat. Posts
   * written from the title alone came out generic, which is what the user
   * reported on 2026-10-31.
   */
  readonly description?: string
  readonly requests: readonly string[]
}

/**
 * Titles that name a container rather than a shoot: a file found only in one
 * of these has no usable project context beyond its own picture.
 */
const GENERIC_TITLE = /^(?:senza titolo|untitled|caricament|caricamento|progetto senza titolo|nuovo progetto)/i

/**
 * The opening words of a reply to one request ("Faccio lo scambio…", "Ho
 * generato un look.", "I made one video.", "No work started."), in both of
 * the page's languages: for lines written before replies carried the runs
 * they queued, and for the replies that queued none.
 */
const RUN_REPORT = /^(?:ho |faccio |ok\b|okay\b|certo\b|nessun lavoro|ecco |i |i'm |i'll |i've |sure\b|here |no work)/i

/**
 * Whether a line reports on a run, or answers one request, rather than
 * describing the project: it never becomes the project's description.
 *
 * A line tied to its runs says so in its fields — a status line carries its
 * `jobId`, a reply that queued runs its `jobIds` — whatever language it was
 * written in; the text is the fallback (until 2026-11-07 it was the only
 * test, and it knew only Italian).
 * @param message - the candidate line.
 * @param text - its text, whitespace-collapsed.
 * @returns true when it must not describe the project.
 */
function isRunReport(message: ImagineMessage, text: string): boolean {
  return message.jobId !== undefined || (message.jobIds?.length ?? 0) > 0 || RUN_REPORT.test(text)
}

/**
 * The description a project carries, wherever it was written.
 *
 * A project seeded from a sentence keeps that sentence; the ones created by
 * the studio have their summary as the project's opening line — the aid
 * written "Progetto «idee-qwen»: contenuti Instagram della persona…" — which is
 * what the caption should carry. Only the opening line counts: later assistant
 * lines are replies to one request ("Faccio lo scambio…") and the lookbook's
 * card lines ("CAT GIRL SAKURA · A - SDRAIATA…") are a pose, not a shoot.
 * @param project - the project record.
 * @returns the description, whitespace-collapsed and capped, or undefined.
 */
function descriptionOf(project: ImagineProject): string | undefined {
  const seed = project.seedPrompt?.replace(/\s+/g, ' ').trim()
  if (seed !== undefined && seed.length > 20) return seed.slice(0, 600)
  // The seed line is the project's own title, not something anyone said
  // about the shoot.
  const opening = project.messages.find(message => !message.id.startsWith(SEED_MESSAGE_PREFIX))
  if (opening?.role !== 'assistant') return undefined
  const text = opening.text.replace(/\s+/g, ' ').trim()
  if (text.length < 40 || text.length > 800 || isRunReport(opening, text)) return undefined
  return text.slice(0, 600)
}

/**
 * The project's own requests, newest last: the lines the user typed in it.
 * @param project - the project record.
 * @returns at most PROJECT_REQUESTS short lines, without repeats.
 */
function requestsOf(project: ImagineProject): readonly string[] {
  const seen = new Set<string>()
  const requests: string[] = []
  for (const message of project.messages) {
    if (message.role !== 'user') continue
    const text = message.text.replace(/\s+/g, ' ').trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    requests.push(text.slice(0, 200))
  }
  return requests.slice(-PROJECT_REQUESTS)
}

/** What stage two wrote. */
interface WrittenPost {
  readonly caption?: string
  readonly subtitle?: string
  readonly hashtags: readonly string[]
}

/**
 * Stage one: what the picture contains.
 *
 * Facts only, and short ones. The caption is written in stage two by a
 * text-only call, as the account's earlier publisher did: its vision pass
 * produced a JSON of franchise_guess / character_guess / visible_elements plus
 * a safety verdict, and an assistant holding the editorial policy wrote the
 * words. A vision model asked for the words itself describes the photo
 * instead, which that same policy lists among the things to avoid.
 *
 * Output length is what costs on this route (~30s per 200 characters
 * generated), so four short lines are asked for and nothing else.
 * @returns the instruction text.
 */
function factsInstruction(isReel: boolean, project: ProjectContext | undefined): string {
  // The project title is what the user called the shoot ("2B Nier", "CAT GIRL
  // SAKURA"): a far better witness of who is in costume than a guess from one
  // frame, which is how posts got the wrong franchise. Its description says
  // what the shoot is about — the theme, the character, the situation — and
  // without it a project called "idee-qwen" told the vision nothing.
  const subject = project === undefined
    ? ''
    : `Questa immagine fa parte del progetto «${project.title}». Se il titolo nomina un personaggio o un franchise, è quello: usalo, a meno che l'immagine mostri chiaramente altro.`
      + (project.description === undefined ? '' : `\nIl progetto, descritto da chi lo ha creato: ${project.description}`)
  const hint = subject === '' ? '' : `${subject}\n\n`
  return `${hint}Guarda ${isReel ? 'questo fotogramma di un video' : 'questa immagine'} e rispondi SOLO con queste quattro righe, niente altro, niente ragionamento:
franchise: il nome dell'opera se riconosci un franchise (anime, videogioco, film, fumetto), altrimenti -
personaggio: il nome del personaggio se lo riconosci, altrimenti -
elementi: tre o quattro cose concrete che si vedono, in italiano, separate da virgola
sicurezza: scrivi ok se il corpo è coperto; scrivi no se si vedono capezzoli, genitali, pube, topless o vestiti trasparenti sulle parti intime`
}

/**
 * Stage two: write the post from the facts.
 *
 * Text only, so no image is uploaded and the call is short. The examples are
 * real captions of the account read from disk rather than hardcoded, so
 * refreshing the voice is a matter of replacing the file.
 * @param facts - what stage one saw.
 * @param type - photo or reel; a reel's caption ends in a micro-CTA.
 * @param prompt - the prompt that generated the file, when a job is known.
 * @param style - example captions carrying the voice.
 * @param recent - captions already used, which must not come back.
 * @returns the instruction text.
 */
function captionInstruction(
  facts: SeenFacts,
  type: PostType,
  prompt: string | undefined,
  style: readonly string[],
  recent: readonly string[],
  project: ProjectContext | undefined,
): string {
  const isReel = type === 'reel'
  const known = [
    project ? `Progetto: ${project.title} (il nome che ho dato a questo servizio fotografico: personaggio e franchise vengono da qui e dalla descrizione)` : undefined,
    project?.description ? `Descrizione del progetto (cosa racconta questo servizio): ${project.description}` : undefined,
    project && project.requests.length > 0 ? `Richieste fatte nel progetto:\n${project.requests.map(request => `- ${request}`).join('\n')}` : undefined,
    facts.franchise ? `Franchise: ${facts.franchise}` : undefined,
    facts.character ? `Personaggio: ${facts.character}` : undefined,
    facts.elements ? `Nella foto si vede: ${facts.elements}` : undefined,
    // Input costs little on this route (output is what is slow): the old
    // 300-character cut dropped the character name from long look prompts.
    prompt ? `Prompt di generazione: ${prompt.slice(0, PROMPT_KEEP)}` : undefined,
  ].filter(Boolean).join('\n')
  const examples = style.length > 0 ? `\n\nEsempi del tono giusto, da post veri di questo profilo:\n${style.map(caption => `- ${caption}`).join('\n')}` : ''
  const avoid = recent.length > 0 ? `\n\nQueste caption sono già state usate: scrivine una diversa, non riciclarle.\n${recent.map(caption => `- ${caption}`).join('\n')}` : ''
  return `Sei una ragazza italiana che pubblica su Instagram. Scrivi la didascalia di una tua foto.

${known}

Rispondi SOLO con queste tre righe, niente altro, niente ragionamento:
caption: una battuta o una frase a effetto, in italiano, prima persona, detta DA chi è nella foto — mai una descrizione di cosa si vede. Massimo 120 caratteri, una o due emoji in fondo.${isReel ? ' Chiudi con una micro-domanda leggera ai follower.' : ' Niente domande ai follower: le domande sono solo per i reel.'}
sottotitolo: una riga breve da sottotitolo, massimo 45 caratteri, oppure - se non serve
hashtag: ${isReel ? 'un hashtag' : 'due hashtag'} concreti sul tema, separati da uno spazio: il nome del personaggio o del franchise se c'è (#naruto, #zelda, #StarWars, #Halo), altrimenti la cosa che si vede in italiano minuscolo (#tramonto, #montagna, #katana). Mai estetica in inglese tipo #UrbanVibes o #aesthetic, mai generici tipo #foto #instagram #girl, mai hashtag sulla persona ritratta.${examples}${avoid}`
}

/**
 * The project a gallery file belongs to, as context for the caption.
 *
 * Read on the server from the shared store rather than sent by the page: an
 * uploaded clip has no job and so no prompt, a post already in the queue was
 * opened without a project, and the page only knows the jobs of the last half
 * hour. A file in more than one project takes the first with a real title.
 * @param name - the gallery item name.
 * @returns title, description and recent requests, or undefined.
 */
async function projectContext(name: string | undefined): Promise<ProjectContext | undefined> {
  if (!name) return undefined
  try {
    const store = await loadImagineStore()
    /*
     * A file can sit on more than one board — an upload dropped twice, a shot
     * adopted by a second project — and the first match used to win whether or
     * not it said anything. The one with a description and a real title wins
     * now: it is the project whose words the caption should carry.
     */
    let best: { project: ImagineProject; score: number } | undefined
    for (const project of store.projects) {
      if (!project.itemNames.includes(name)) continue
      const description = descriptionOf(project)
      const requests = requestsOf(project)
      const score = (description === undefined ? 0 : 4)
        + (GENERIC_TITLE.test(project.title) ? 0 : 2)
        + Math.min(2, requests.length)
      if (best === undefined || score > best.score) best = { project, score }
    }
    if (best === undefined) return undefined
    const project = best.project
    const description = descriptionOf(project)
    return {
      title: project.title,
      ...description === undefined ? {} : { description },
      requests: requestsOf(project),
    }
  } catch (error: unknown) {
    // Without the project the caption is guessed from the picture, as before.
    log(`project lookup failed: ${errorText(error)}`)
    return undefined
  }
}

/**
 * Read the three lines back out of the writer's reply.
 *
 * Labelled first, then by position: the model keeps the order and drops the
 * labels often enough that insisting on them threw away good posts — one reply
 * was "Sole in faccia, testa tra le nuvole. / - / #tramonto
 * #montagna", correct in every way except the three words in front.
 * @param written - the model's reply.
 * @returns the caption, its optional subtitle, and the hashtags.
 */
function readPost(written: string): WrittenPost {
  const labelled = readVisionField(written, 'caption')
  if (labelled !== undefined) {
    return {
      caption: labelled,
      subtitle: readVisionField(written, 'sottotitolo'),
      hashtags: readVisionHashtags(written),
    }
  }
  const lines = written.split('\n').map(line => line.trim()).filter(line => line.length > 0 && line !== '-')
  const tagLine = lines.findIndex(line => line.startsWith('#'))
  const prose = (tagLine === -1 ? lines : lines.slice(0, tagLine)).filter(line => !line.startsWith('#'))
  return {
    caption: prose[0],
    subtitle: prose[1],
    hashtags: tagLine === -1 ? [] : readVisionHashtags(`hashtag: ${lines[tagLine] ?? ''}`),
  }
}

/**
 * Run the text-only writer over the facts.
 * @param facts - what stage one saw.
 * @param type - photo or reel.
 * @param prompt - the generating prompt, when known.
 * @returns the written lines, or undefined to fall back to the templates.
 */
async function writeCaption(facts: SeenFacts, type: PostType, prompt: string | undefined, project: ProjectContext | undefined): Promise<WrittenPost | undefined> {
  if (currentRoutes().text === undefined) return undefined
  const [style, recent] = await Promise.all([readRecent(stylePath(), 4), readRecent(recentPath(), 6)])
  const started = Date.now()
  const written = await askModel(captionInstruction(facts, type, prompt, style, recent, project), VISION_TIMEOUT)
  if (typeof written !== 'string') {
    log(`caption writer gave nothing after ${String(Date.now() - started)}ms`)
    return undefined
  }
  log(`caption written in ${String(Date.now() - started)}ms, ${String(written.length)} chars`)
  return readPost(written)
}

/**
 * A caption is usable when the model answered with copy and not with its
 * own scaffolding, an apology or an essay.
 * @param caption - the candidate caption.
 * @returns true when it can be shown to the user.
 */
function isUsableCaption(caption: string | undefined): caption is string {
  if (caption === undefined) return false
  if (caption.length < 8 || caption.length > 300) return false
  if (/\b(soggetto|outfit|luogo|mood|caption)\s*:/i.test(caption)) return false
  if (/^(mi dispiace|non posso|come (?:modello|assistente)|i'm sorry|i cannot)/i.test(caption)) return false
  return true
}

/**
 * Run the vision pass over one gallery item.
 *
 * Never throws — a missing route, a slow model or a reply in the wrong shape
 * all fall back to the templates, because a generic caption the user can
 * edit is better than a panel that will not open.
 * @param name - the gallery item name.
 * @param type - photo or reel, which picks the instruction.
 * @returns the parsed description, or undefined to keep the templates.
 */
async function analyzeMedia(name: string | undefined, type: PostType, project: ProjectContext | undefined): Promise<SeenFacts | undefined> {
  const route = currentRoutes().vision
  if (route === undefined) return undefined
  const path = await resolveMediaPath(name)
  if (path === undefined || name === undefined) return undefined
  // Stills are read as they are, clips through a frame pulled out first:
  // the gallery's own table decides which is which.
  const kind = kindOf(name)
  const isVideo = kind === 'video'
  if (kind !== 'image' && !isVideo) return undefined
  let target = path
  let dir: string | undefined
  const cleanup = async (): Promise<void> => { if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined) }
  if (isVideo) {
    // One ffmpeg pulls the frame and shrinks it for the model.
    try {
      dir = await mkdtemp(join(tmpdir(), 'social-vision-'))
      target = await frameAt(path, join(dir, 'frame.jpg'), { at: 0.5, maxSide: VISION_MAX_SIDE, quality: 3, timeoutMs: 20_000 })
    } catch {
      await cleanup()
      return undefined
    }
  }
  const started = Date.now()
  try {
    // A still is shrunk by the vision service itself; lookWith aborts the
    // request on the deadline instead of leaving the model answering.
    const result = await lookWith(socialHost().auxiliary, target, factsInstruction(type === 'reel', project), route, VISION_TIMEOUT, { maxSide: VISION_MAX_SIDE })
    if (result === undefined) {
      log(`vision gave nothing on ${name} after ${String(Date.now() - started)}ms (timeout ${String(VISION_TIMEOUT)}ms)`)
      return undefined
    }
    const text = result.text
    log(`vision ok on ${name} in ${String(Date.now() - started)}ms, ${String(text.length)} chars, provider=${String(result.provider)} model=${String(result.model)}`)
    const safety = readVisionField(text, 'sicurezza')
    return {
      franchise: readVisionField(text, 'franchise'),
      character: readVisionField(text, 'personaggio'),
      elements: readVisionField(text, 'elementi'),
      unsafe: safety !== undefined && /^(no|non|rischio)/i.test(safety),
      safety,
      text,
    }
  } finally {
    await cleanup()
  }
}

/**
 * Handle POST …/social/caption-preview
 *
 * Body: { type?: "photo"|"reel", filename?: string, prompt?: string }
 *
 * Generates caption + hashtags following the account's editorial policy:
 * - Photos: 5 hashtags (3 fixed + 2 dynamic), first-person Italian caption
 * - Reels: 5 hashtags (4 fixed + 1 dynamic), micro-CTA for comments
 */
export async function handleCaptionPreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readObject(req)
  // Anything but a reel is written as a photo, as the templates always were.
  const postType: PostType = body.type === 'reel' ? 'reel' : 'photo'
  const filename = typeof body.filename === 'string' ? body.filename : undefined
  /*
   * The prompt a file was generated from is filed beside it (its note), and
   * the page only knows the jobs of the last half hour: an older post used to
   * be written with no prompt at all, from title and frame alone.
   */
  const note = filename === undefined ? undefined : await recallNote(filename).catch(() => undefined)
  const asked = typeof body.prompt === 'string' && body.prompt.trim() !== '' ? body.prompt : note?.origin?.prompt
  const prompt = asked === undefined || asked.trim() === '' ? undefined : asked
  const project = await projectContext(filename)
  // What the writer was told, in one line: the project title alone and a
  // project described in a paragraph produce very different captions, and
  // the journal is where that difference is read back.
  log(`context: project «${project?.title ?? '-'}», `
    + `${project?.description === undefined ? 'no description' : `description of ${String(project.description.length)} characters`}, `
    + `${String(project?.requests.length ?? 0)} requests, ${prompt === undefined ? 'no prompt' : 'the file\'s prompt'}`)
  // Without a look, what was already seen of the file (a clip's description
  // filed by the upload scan) still gives the writer something concrete.
  const seen = await analyzeMedia(filename, postType, project)
    ?? (note?.sight === undefined ? undefined : { elements: note.sight, unsafe: false, text: note.sight })
  const written = seen === undefined ? undefined : await writeCaption(seen, postType, prompt, project)
  const caption = written?.caption
  const fromWriter = isUsableCaption(caption)
  if (written !== undefined && !fromWriter) log(`caption rejected: ${JSON.stringify(caption)}`)
  const headline = fromWriter ? caption : pickCaption(postType, {})
  const subtitle = fromWriter && written?.subtitle !== undefined && written.subtitle.length <= 60 ? written.subtitle : undefined
  if (fromWriter) await rememberRecent(recentPath(), headline, 'caption')
  // The franchise and the character outrank the prompt for the dynamic tags:
  // an old file may have no job behind it, and the filename says little.
  // The project title goes first of all: the keyword table takes its first hit.
  const promptSource = [project?.title, project?.description, seen?.franchise, seen?.character, seen?.elements, prompt, filename].filter(Boolean).join(' ')
  sendJson(res, 200, {
    ok: true,
    caption: subtitle === undefined ? headline : `${headline}\n${subtitle}`,
    hashtags: generateHashtags(postType, promptSource, written?.hashtags ?? []),
    source: fromWriter ? 'written' : seen !== undefined ? 'facts-only' : 'template',
    unsafe: seen?.unsafe === true,
    vision: seen === undefined ? undefined : { franchise: seen.franchise, character: seen.character, elements: seen.elements, safety: seen.safety },
    project: project?.title,
  })
}
