/**
 * The studio's conversational lane: one written line turned into a run.
 *
 * Inside a project there are no controls — no mode, no ratio, no duration
 * button. What the user writes has to carry all of it ("genera un video da 10
 * secondi verticale"), so something has to read the sentence and answer with
 * the same fields the toolbar used to set. That is this module: a text call
 * that returns an intent, never a side effect, so a wrong reading costs a
 * corrected sentence rather than a run on the GPU.
 *
 * The client owns the mapping from those fields to workflow inputs
 * (`imagine-settings`), so this module names ladder steps and not megapixels:
 * one place keeps the deployment's numbers, and it is the one the toolbar
 * already used.
 * @module tool-comfy/imagine-chat
 */

import { join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import {
  IMAGINE_ACTIONS, IMAGINE_OBJECT_MODES, IMAGINE_QUALITIES, IMAGINE_SPEEDS,
  type ImagineAction, type ImagineObjectMode, type ImagineQuality, type ImagineRegion, type ImagineSpeed,
} from '../../../shared/imagine-types.ts'
import { RELIGHT_LOOKS, relightLookOf } from '../../../shared/relight-looks.ts'
import {
  IMAGE_RESOLUTIONS, IMAGINE_ASPECTS, MAX_STORY_SECONDS, UPSCALE_IMAGE_STEPS, UPSCALE_VIDEO_STEPS,
  aspectNearest, type ImagineResolution,
} from '../../../shared/imagine-media.ts'
import { LOOP_SECONDS, clampSeconds, clampStorySeconds } from '../../../shared/imagine-sizing.ts'
import { MUSIC_MAX_SECONDS, MUSIC_MIN_SECONDS } from './music-prompt.ts'
import { ACTION_RUNS } from './job-request.ts'
import { probePixels, safeBasename } from './gallery.ts'
import { finite, textField } from './guards.ts'
import { streamText, textRoutes, type StreamCapable } from './imagine-models.ts'
import { message } from '../../src/messages.ts'
import { lookAtStaged, sightInMemory, type ImagineChatEyes } from './imagine-sight.ts'
import { languageName } from '../../../shared/locale-names.ts'
import { recallNotes, type ImagineFileOrigin } from './imagine-notes.ts'
import { retryEditIntents, type EditRun } from '../../../shared/imagine-edit.ts'
import { LIPSYNC_MIN } from './story.ts'
import { jsonObjectOf } from './model-json.ts'
import type { WorkflowChange } from './workflow-edit.ts'
import type { MediaFileRef } from '../../../shared/imagine-types.ts'
import type { CustomInput } from '../../../shared/custom-workflows.ts'
import type {
  ImagineChatAsk, ImagineChatEvent, ImagineChatIntent, ImagineChatReply, WorkflowField, WorkflowFieldFact,
  WorkflowPlan,
} from '../../../shared/imagine-chat.ts'

/** Most runs one written line may queue, so a misread cannot fill the GPU. */
const MAX_INTENTS = 4

/**
 * Most runs one line may queue per file the user actually put in chat.
 *
 * The four above guard a misread, and a sentence written over files has
 * nothing left to guess: eight clips in chat and one thing asked for them is
 * eight runs, not a reading gone wild. Measured 2026-10-24: one action asked
 * over eight clips came back as four runs and a reply telling the user to ask
 * again for the other four. What bounds the queue is the page's
 * own staging, up to this.
 */
const MAX_INTENTS_PER_FILE = 24

/** Most inputs one written line may propose changing. */
const MAX_CHANGES = 8

/**
 * How many values of a closed list the second pass is shown.
 *
 * A checkpoint or LoRA folder can hold hundreds of names, and printing all of
 * them would put a catalogue behind one sentence. The list is truncated with
 * its length said out loud, so the reading knows the rest exists and does not
 * invent a name from the visible ones.
 */
const OPTIONS_IN_PROMPT = 40

/**
 * How many files of each kind the reading is shown.
 *
 * Eight files in all was the old ceiling, newest first — and a music-video
 * project ends with its clips, so "rifare il videoclip con le foto del
 * progetto" found eight videos, no photo and no song, and asked what the user
 * meant. The photos are what a montage is made of, and a project has a dozen
 * of them; the clips are what it made, and two or three are enough to point
 * at "l'ultimo video".
 */
const INVENTORY_LIMITS: Readonly<Record<ImagineChatFile['kind'], number>> = { image: 40, audio: 8, video: 8 }

/**
 * The project's files as the reading sees them: grouped by kind, newest first.
 * @param files - what the board is showing, newest first.
 * @returns the lines for the instruction, or empty when there is nothing.
 */
function projectInventory(files: readonly ImagineChatFile[]): string {
  const groups: [ImagineChatFile['kind'], string][] = [['image', 'Images'], ['audio', 'Audio'], ['video', 'Video']]
  const lines: string[] = []
  for (const [kind, label] of groups) {
    // The isolated vocal a montage sings to is a by-product of the chain, not
    // a song anyone would pick: offered as one, the reading had four audio
    // files for two songs and asked which to use.
    const mine = files.filter(file => file.kind === kind && !(kind === 'audio' && file.name.startsWith('vocals-')))
    if (mine.length === 0) continue
    const shown = mine.slice(0, INVENTORY_LIMITS[kind])
    const more = mine.length - shown.length
    lines.push(`${label}${more > 0 ? ` (the ${String(shown.length)} most recent of ${String(mine.length)})` : ''}:`)
    for (const file of shown) lines.push(`- ${fileLine(file)}`)
  }
  return lines.join('\n')
}

/** Longest description shown for a board file: the staged ones get it whole. */
const BOARD_SIGHT_CHARS = 220

/**
 * One file as the reading sees it: its name, how it was made, what is in it.
 *
 * The name alone is what the reading used to get, and "rifai queste foto di
 * Imperatrice in 9:16" met thirteen names: it asked which poses were meant
 * when the studio had chosen every one of them. The origin says what a run
 * would need to make the file again; the sight says what is in it, for the
 * files nobody staged.
 * @param file - the file, with whatever the host filed about it.
 * @param sightChars - how much of the description to show.
 * @returns the line, without its bullet.
 */
function fileLine(file: ImagineChatFile, sightChars = BOARD_SIGHT_CHARS): string {
  const parts = [file.name]
  const made = file.made === undefined ? undefined : originLine(file.made)
  if (made !== undefined) parts.push(made)
  if (file.seen !== undefined) {
    const text = file.seen.replace(/\s+/g, ' ').trim()
    parts.push(`si vede: ${text.length > sightChars ? `${text.slice(0, sightChars - 1)}…` : text}`)
  }
  return parts.join(' — ')
}

/** How a file was made, in the fields a run would take to make it again. */
function originLine(origin: ImagineFileOrigin): string {
  const bits: string[] = []
  const prompt = origin.prompt.replace(/\s+/g, ' ').trim()
  const short = prompt.length > 90 ? `${prompt.slice(0, 89)}…` : prompt
  bits.push(`made with ${origin.action}${short.length === 0 ? '' : ` «${short}»`}`)
  if (origin.source !== undefined) bits.push(`from ${origin.source}`)
  if (origin.aspect !== undefined) bits.push(origin.aspect)
  if (origin.resolution !== undefined) bits.push(origin.resolution)
  if (origin.seconds !== undefined) bits.push(`${String(origin.seconds)} s`)
  // The probe's number, in words the reader can act on: a weak shot is the
  // one to redo when the user says the singing is off.
  if (origin.lipsync !== undefined) {
    bits.push(`lipsync ${origin.lipsync < LIPSYNC_MIN ? 'weak' : 'in time'} (${origin.lipsync.toFixed(2)})`)
  }
  return bits.join(', ')
}

/**
 * A line the studio must not answer by generating it.
 *
 * A question mark, or an opening the sentence can only be asking with: without
 * a reading every line was turned into an image of itself, which is a run on
 * the GPU and a picture of the words instead of an answer. "Come" and "how"
 * are not on the list although they open a question: they open a prompt too
 * ("come un dipinto a olio"), and this is the path where nothing is reading.
 */
const ASKED = /\?\s*$|^\s*(?:perch[eé]|cosa|quanto|quanti|quante|quale|quali|chi|dove|quando|puoi|sai|riesci|why|what|can you)\b/i

/**
 * Actions the chat may queue: every studio action but the one nobody asks for
 * by name.
 *
 * `scanFrame` is the half of «Recreate video» that draws the candidates and
 * stops for a choice: a written line queues the whole recipe, which draws its
 * one opening frame and goes on, because a chat turn cannot wait for a click.
 * The choice belongs to the card, where the candidates are on screen
 * (2026-10-24/25).
 */
const ACTIONS: readonly ImagineAction[] = IMAGINE_ACTIONS.filter(action => action !== 'scanFrame')

/**
 * Whether the user's line sends the video to Instagram's vertical frame.
 *
 * "reel" and "storia" say where a video goes, not what it is, so they do not
 * pick an action: they pick a format. Read from the user's own words because
 * the reply only carries what the model chose to copy, and this is the one
 * part of a reel that is a fact rather than a choice.
 * "storia" is matched on the singular and plural but not on "storico" or
 * "storia di", which are ordinary Italian words a request may well contain.
 * @param asked - the line the user wrote, as the reader received it.
 * @returns true when the clip is destined for a reel or a story.
 */
function wantsReel(asked: string): boolean {
  // "storia di" opens an ordinary sentence ("una storia di amicizia"), and the
  // negative lookahead keeps it out.
  return /\b(?:reels?|storie)\b/i.test(asked)
    || /\bstoria\b(?!\s+di\b)/i.test(asked)
}

/**
 * Whether the line itself names an aspect, in words or as a ratio.
 *
 * "un reel orizzontale", "in 16:9", "quadrato": the reading may echo the
 * format back in its own field either way, so the only trustworthy sign that
 * the user chose it is the user's line.
 * @param asked - the sentence as written.
 * @param aspect - the format the reading proposed.
 * @returns true when the sentence asks for that format.
 */
function namesRatio(asked: string, aspect: string): boolean {
  const [w, h] = aspect.split(':')
  if (w === undefined || h === undefined) return false
  const flat = `\\b${w}\\s*[:x/]\\s*${h}\\b`
  if (new RegExp(flat, 'i').test(asked)) return true
  const words: Record<string, RegExp> = {
    '16:9': /\b(?:orizzontale|landscape|wide|widescreen)\b/i,
    '9:16': /\b(?:verticale|portrait|vertical)\b/i,
    '1:1': /\b(?:quadrato|square)\b/i,
  }
  return words[aspect]?.test(asked) === true
}

/** One staged or recent file the sentence may be pointing at. */
interface ImagineChatFile extends MediaFileRef {
  /**
   * The file's pixel shape, when the host read it from the header.
   *
   * A clip animated from a still is rendered at the still's own shape unless
   * the user asks for another, and the reader can only do that if it is told
   * what the still looks like.
   */
  readonly width?: number
  readonly height?: number
  /**
   * How the studio made it, when the studio made it.
   *
   * Filled by the host from the file's note, not by the client: the job that
   * produced a photo is pruned from memory half an hour after it finishes,
   * and the note is what outlives it.
   */
  readonly made?: ImagineFileOrigin
  /** What a vision model saw in it, when something already looked. */
  readonly seen?: string
}

/**
 * How many runs one written line may queue, given the files it was written over.
 *
 * A line asking for one thing over the files the user staged is one run per
 * file: the ceiling follows the staging, while `MAX_INTENTS` stays the guard on
 * the number of DIFFERENT things one line may ask for.
 * @param staged - the files the user put in chat.
 * @returns at least `MAX_INTENTS`, and one per staged file past that.
 */
function intentCeiling(staged: readonly ImagineChatFile[]): number {
  return Math.max(MAX_INTENTS, Math.min(staged.length, MAX_INTENTS_PER_FILE))
}

/**
 * What the studio tells the reader about the state the sentence was written in:
 * the page's own body (`ImagineChatAsk`), with what only the host knows added.
 */
export interface ImagineChatRequest extends Omit<ImagineChatAsk, 'staged' | 'recent'> {
  /**
   * The interface language (`x-app-language`), for the texts the model writes
   * on our behalf: the description of what is visible in a file.
   */
  readonly language?: string
  /** Files staged in the composer, with what the host filed about them. */
  readonly staged?: readonly ImagineChatFile[]
  /** The newest files on the board, with what the host filed about them. */
  readonly recent?: readonly ImagineChatFile[]
  /**
   * The voices this deployment installed, as the RVC loader spells them.
   *
   * Filled by the host from the voice workflow rather than by the client: the
   * list is a property of the models on the ComfyUI box, and the studio has no
   * other way to know it.
   */
  readonly voices?: readonly string[]
}

/**
 * One workflow the chat may talk about, as the reading is shown it.
 *
 * `file` is the graph file for a configured entry and the card's title for a
 * personal one: an id like `custom:6f…` names nothing a reader can act on, and
 * a card's title and description are what say when to use it (2026-11-18).
 */
export interface WorkflowSummary {
  /** The key the chat and the settings page address it by. */
  readonly key: string
  /** What the settings page calls it. */
  readonly label: string
  /** The graph file, or the card's title when this entry is a personal card. */
  readonly file: string
  /** The name the job runner knows its graph by, when it has one. */
  readonly run?: string
  /**
   * When to use this workflow: the entry's own `description`, or the personal
   * card's.
   */
  readonly description?: string
  /** The personal card this entry points at, when it points at one. */
  readonly card?: { readonly id: string; readonly title: string; readonly description: string }
}

/** One personal card, as a written line may run it (`action: custom`). */
export interface WorkflowCard {
  /** The id the MCP and the card list know it by. */
  readonly id: string
  readonly title: string
  readonly description: string
  /** The inputs the card exposes, so a sentence can fill them by name. */
  readonly inputs: readonly CustomInput[]
}

/**
 * The workflows the studio may talk about, and what it may do with them.
 *
 * The graphs live outside the repository, so the studio is told about them by
 * whoever loaded them rather than reading a directory: what is offered here is
 * exactly what this deployment configured and nothing else.
 */
export interface WorkflowInventory {
  /** What the studio can name: the key it is addressed by and its file. */
  readonly list: readonly WorkflowSummary[]
  /**
   * The personal cards the studio holds, whichever of them `config.yaml` also
   * points at, so a sentence can run one as `action: custom` with its id.
   */
  readonly cards?: readonly WorkflowCard[]
  /**
   * One workflow's editable inputs, node by node.
   * @param key - the workflow's key.
   * @returns the node list, or undefined when no such workflow is configured.
   */
  summarise(key: string): string | undefined
  /**
   * One workflow's editable inputs as rows a settings page can render.
   * @param key - the workflow's key.
   * @returns the rows, or undefined when no such workflow is configured.
   */
  fields(key: string): readonly WorkflowField[] | undefined
  /**
   * What each input accepts, read from ComfyUI: a combo's closed list, a
   * number's bounds and step. Absent facts are not a reason to refuse a
   * change, only to check less.
   * @param key - the workflow's key.
   * @returns the facts, or undefined when no such workflow is configured.
   */
  facts(key: string, signal?: AbortSignal): Promise<readonly WorkflowFieldFact[] | undefined>
  /**
   * What the configured pins of one workflow no longer address.
   * @param key - the workflow's key.
   * @returns one line per stale pin, or undefined when no such workflow is configured.
   */
  warnings(key: string): readonly string[] | undefined
  /**
   * Whether this workflow was changed inside the app, so that the user's copy
   * of the graph wins over the one that ships with the program.
   * @param key - the workflow's key.
   * @returns true when a copy exists.
   */
  overridden(key: string): boolean
  /**
   * The values one node input accepts, when the server publishes a list.
   * @param key - the workflow's key.
   * @param node - the node id inside the graph.
   * @param field - the input key.
   * @returns the accepted values, or undefined when the node, field, or list is unavailable.
   */
  options(key: string, node: string, field: string): Promise<readonly string[] | undefined>
  /**
   * Work out what a set of changes would do, writing nothing.
   * @param key - the workflow's key.
   * @param changes - the changes asked for.
   * @param facts - what each input accepts, when the caller read them.
   * @returns the plan, or undefined when no such workflow is configured.
   */
  plan(key: string, changes: readonly WorkflowChange[], facts?: readonly WorkflowFieldFact[]): WorkflowPlan | undefined
}

/** Told about each step of a reading as it happens; never throws. */
type ImagineChatWatcher = (event: ImagineChatEvent) => void

/**
 * The composition the page is holding, as one phrase.
 *
 * Only the fields that are set are written: an empty one is not a choice, and
 * telling the reader "stile: (niente)" would let it answer about a preset
 * nobody picked. The mode travels as the client's own id and is spelled out
 * here, because "style" is this deployment's word for a chip, not the reader's
 * word for an action.
 * @param preset - the chip and the catalogue fields the client sent.
 * @returns the phrase, or an empty string when nothing is selected.
 */
function presetLine(preset: ImagineChatRequest['preset']): string {
  if (preset === undefined) return ''
  const parts: string[] = []
  const mode = preset.mode === undefined ? undefined : PRESET_MODES[preset.mode] ?? preset.mode
  if (mode !== undefined && mode.length > 0) parts.push(`ready action: ${mode}`)
  if (preset.style !== undefined && preset.style.length > 0) parts.push(`style: ${preset.style}`)
  return parts.join(', ')
}

/** The composer modes, in the words of the actions above. */
const PRESET_MODES: Readonly<Record<string, string>> = {
  image: 'generate',
  video: 'video',
  loop: 'loop',
  music: 'music',
  style: 'remix (changes the style of an image)',
  speak: 'speak',
  recreate: 'recreate (recreates a clip: analysis, first frame with Krea 2, then reshoot)',
}

/**
 * The instruction that turns one line into runs.
 *
 * Written as a dispatcher rather than as a creative brief: the prompt that
 * reaches the sampler is still written by the vision pass and the story
 * director downstream, and a reader that also rewrote the user's words would
 * be a second author fighting them.
 * @param request - the line and the state it was written in.
 * @returns the prompt sent to the reading model.
 */
function imagineChatInstruction(
  request: ImagineChatRequest,
  inventory?: WorkflowInventory,
  eyes?: ImagineChatEyes,
): string {
  /*
   * A card says who it is by its title and what it is for by its description:
   * a configured entry pointing at one used to be listed with the UUID it is
   * stored under, which the reading could neither pronounce nor choose.
   */
  const workflows = (inventory?.list ?? [])
    .map(entry => {
      const name = entry.card?.title ?? entry.label
      const when = entry.description ?? entry.card?.description
      const file = entry.card === undefined ? entry.file : `personal card ${entry.card.id}`
      return `- ${entry.key}: ${name} (${file})${when === undefined ? '' : ` — when to use it: ${when}`}`
    }).join('\n')
  /*
   * The personal cards, with their id and their controls: a sentence may run
   * one as `action: custom` exactly as the MCP's `custom` action does, and the
   * id is the only way to name it.
   */
  const cards = (inventory?.cards ?? []).map(card => {
    const inputs = card.inputs.length === 0
      ? ''
      : `; inputs: ${card.inputs.map(input => `${input.label} = ${input.node}.${input.field} (${input.kind})`).join(', ')}`
    return `- ${card.id}: ${card.title}${card.description.trim().length === 0 ? '' : ` — ${card.description}`}${inputs}`
  }).join('\n')
  /*
   * A staged file carries what was already seen in it — a clip's description
   * is only ever this one, since the look below reads stills — unless the look
   * below has just described it, in full, in the list of sights.
   */
  const sighted = new Set((eyes?.sights ?? []).map(sight => sight.name))
  const staged = (request.staged ?? []).map(file => `- ${fileLine({
    name: file.name,
    kind: file.kind,
    ...file.made === undefined ? {} : { made: file.made },
    ...file.seen === undefined || sighted.has(file.name) ? {} : { seen: file.seen },
  })} (${file.kind}, in chat)`).join('\n')
  /*
   * What the staged stills actually show. Without this the reading is told a
   * name and a kind and describes the picture anyway: asked the colour of a
   * solid blue field it answered "chiaro e neutro". A description that was
   * looked up is trusted over the model's own idea of the file, and when
   * nothing could look the instruction says so instead of leaving the gap that
   * invention fills.
   */
  const sights = (eyes?.sights ?? [])
    .map(sight => `- ${sight.name}: ${sight.description}`).join('\n')
  const recent = projectInventory(request.recent ?? [])
  const history = (request.history ?? []).slice(-8)
    .map(line => `${line.role === 'user' ? 'User' : 'Studio'}: ${line.text}`).join('\n')
  const events = (request.events ?? []).slice(-6).map(line => `- ${line}`).join('\n')
  const voices = (request.voices ?? []).join(' | ')
  const working = (request.working ?? []).map(run =>
    `- ${run.action}: ${run.status === 'queued' ? 'waiting for its turn on the GPU' : 'running'}`
    + `${run.percent === undefined ? '' : `, ${String(run.percent)}%`}`
    + `${run.stage === undefined ? '' : ` (node ${run.stage})`}`
    + `${run.etaSeconds === undefined ? '' : `, about ${String(run.etaSeconds)} s left`}`).join('\n')
  const preset = presetLine(request.preset)
  /*
   * The language to write the prose in: the interface's, not the sentence's.
   * Someone using the studio in English who writes in Italian wants an
   * English answer, as for project titles and file descriptions
   * (2026-11-04).
   */
  const language = languageName(request.language)
  /*
   * One run per file the user staged, plus the four a misread could need:
   * eight clips in chat are eight runs, and a ceiling of four made the reading
   * drop half of them and hand the rest back to the user (2026-10-24). The
   * number is spelled out in the rules below, so the reader knows how many
   * runs it may answer with.
   */
  const ceiling = intentCeiling(request.staged ?? [])
  /*
   * The light looks, spelled out: they are a closed choice and the reader must
   * copy the id, as for the lookbook's titles and poses. An invented id is a
   * light that does not exist and would be refused by the server.
   */
  const relightList = RELIGHT_LOOKS.length === 0
    ? ''
    : `\n  Looks available, to be copied exactly (id — English name — Italian name): ${RELIGHT_LOOKS.map(look => `${look.id} — ${look.nameEn} — ${look.name}`).join(' | ')}`
  /*
   * What the reader may say about the runs of this project.
   *
   * Spelled out here rather than inline: the prompt is one template literal,
   * and an apostrophe in a conditional arm is a syntax error waiting to
   * happen. The empty case says there is nothing running — the reader used to
   * fill that gap by itself, with "risulta in coda" for a run nobody queued.
   */
  const running = working.length === 0
    ? 'Runs in progress RIGHT NOW in this project: none.'
    + ' If the user asks whether it is going, whether it is queued or how far it is, tell them there is no run in progress:'
    + ' do NOT say anything is queued or running, and do not promise it will start by itself.'
    : 'Runs in progress RIGHT NOW in this project (this is the true state, nothing else is):\n' + working
    + '\nIf the user asks whether it is going or how far it is, answer ONLY from this list, with the state and the percentage you read here.'
  return `You are the Imagine studio. The user talks to you in the chat and you decide WHAT to generate: there are no buttons, everything goes through what they write.

Actions you can queue:
- generate: a new image from text. It does NOT take any starting file: to change an image that is already there the action is "remix".
- remix: edits an image that is already there (it needs a starting image). It REDRAWS THE WHOLE PHOTO, not just the part the prompt names: what the prompt lists, the model redraws.
- video: animates an image as ONE continuous take, from 5 up to ${String(MAX_STORY_SECONDS)} seconds: up to 6 seconds it is one clip, past that the studio renders it scene after scene (6 seconds each) with no cut. Use it for any length when the video starts from one photo and has no song.
- loop: ANIMATED BACKGROUND from an image (it needs "source"): the clip begins and ends on the SAME frame, so it repeats as a loop with no seam, and that is what you want for a background, a video wall, an animation to put on a cycle. "seconds" goes up to ${String(Math.max(...LOOP_SECONDS))}: past 10 seconds the studio renders several segments and joins them, and the file comes out at the length asked for. Do NOT use it to animate a scene with a beginning and an end: that is "video".
- extend: continues a video that is already there (it needs a starting video).
- story: a video CUT into shots, 20-${String(MAX_STORY_SECONDS)} seconds: a video over a song, or one made of several photos (one shot per photo). A long take that develops from ONE photo, without a song, is NOT story: it is video (the studio renders it as one continuous take, scene after scene, up to ${String(MAX_STORY_SECONDS)} seconds). It takes "lyrics": the text the clips themselves sing. It is done in two ways:
  - single take over a song: "source" is ONE image and every piece continues the one before, cut to the song. Without a song a single take is video, not story.
  - cutting between shots: "sources" is a LIST of images (from the files below) and every photo becomes a shot, cut one after the other. That is what a MUSIC VIDEO wants: if the user says "use the project's photos" or has several available, list them in "sources" instead of choosing one. "Redo the music video" / "do it again with the project's files" means exactly this, and it is NOT a question: a single story action with ALL the project's images in "sources" (in the order of the list) and, if the project has audio, the most recent one as "song"; "seconds" is decided by the song, do not write it. Do not ask which song or which photos: they have already chosen them, they are the project's own.
- upscale: raises the resolution of an image or a video that is already there.
- bg: removes the background from an image.
- recreate: RECREATES a video that is already there, shooting it again from scratch. It needs ONE file only: "source" is the reference VIDEO. The studio reads the frames of the clip, redraws the FIRST frame with Krea 2 and then shoots the clip again from that frame with a prompt written on purpose by the analysis. It is the right action for "recreate this video", "do this video again, the same", "reshoot this clip starting from its first frame", "do it again with a different beginning", "recreate it in another scene". "prompt" is the user's direction ("closer", "make her dance", "turn the camera left", "at night"), possibly empty. "keepAudio": true keeps the reference clip's audio, false leaves the audio the video model writes by itself: put true when the user says "keep the audio", "with its own track", "the original audio", "leave the voice"; false or absent when they ask for a new audio or another music. The reshot clip lasts at most 10 seconds: if the reference is longer, say so in "reply" instead of promising the whole length.
- regenerate: REGENERATES THE DETAIL of a video that is already there, remaking it at 1.5x with the Open-H3 refiner (three steps). It is not an upscale: the clip is redrawn, so the detail is new (pores, fabric weave, hair) and the scene stays the same. It needs ONE file only: "source" is the VIDEO. It is the right action for "regenerate the detail", "make this clip sharper", "regenerate it at 1.5x", "make it crisper without changing the scene". The clip comes out with ITS OWN original audio. "prompt" is OPTIONAL and almost always goes empty: without it the studio recovers the prompt the clip was born with from its note, then looks at it, and in any case never starts with an empty prompt; write it only if the user says what they want to see. It is NOT "upscale" (that interpolates and does not redraw), NOT "recreate" (that reshoots the scene from a frame drawn by Krea 2, with another person) and NOT "video" (that animates a photo).
- objectSwap: EDITS AN OBJECT inside a video: it needs ONE file, "source" = the VIDEO, and "objectMode" says which edit. "change" puts the object of a PHOTO in place of the one in the clip ("reference" = that photo); "remove" takes the tracked object out of the shot; "background" replaces the setting around the tracked subject, who keeps their exact look and performance; "add" puts a new object into the shot. It is the right action for "swap the bottle", "remove the chair from this clip", "change the background of this video", "put this glass on the table in the clip"; read the mode off the verb — take something out = "remove", change the place around the subject = "background", put something new in = "add", put the object of a photo in place of the one there = "change". The tracked object is found by the studio itself from the video: do NOT ask which object unless the sentence names none. "prompt" is what to do and it is REQUIRED: write it from the user's words (for "remove" say what has to disappear, for "background" describe the new setting, for "add" the object and where it goes, for "change" any note about the scene). It does NOT change a PERSON (that is swapPerson) and it is NOT "remix" (that edits a photo).
- swapPerson: REPLACES THE MAIN PERSON of a video with the person in a PHOTO, keeping the clip's motion, framing, setting and soundtrack. It needs TWO files: "source" = the VIDEO, "reference" = the PHOTO of the new character. The studio describes the photo and writes the shots by itself, so "prompt" is optional (a note at most). It is the right action for "put the man in this photo in place of the woman in the clip", "swap the person in this video with her", "make him play this scene". It is NOT objectSwap (that edits an object, a garment or the setting) and it is NOT recreate.
- relight: LIGHTS a photo that is already there with one of the seventeen light looks of the studio (a club in magenta, red and blue gels, firelight, a phone screen in a dark room, venetian blinds, a camera flash…). It needs ONE file: "source" is the PHOTO. "light" is the look, copied EXACTLY as an id from the list below (or omitted: the studio uses the first look). It is the right action for "illuminate it like in a club", "put a red and blue light on it", "make it look like firelight", "change the light of this photo", "relight this photo". "prompt" is not needed: the light IS the instruction. It is NOT "remix" (that changes what is in the photo) and NOT "video" (that animates it).${relightList}
- compose: COMPOSES TWO PHOTOS INTO ONE — a person (or object) and a reference that says how they should look or where they should be: "put her in this dress", "make him pose like this", "this person in this setting", "compose these two photos". It needs TWO images: "source" = the person/object that stays, "reference" = the costume, pose or setting to take. "prompt" is optional and says what to take from the reference when it is not obvious. It is NOT "remix" (that edits one photo and needs no second one) and NOT "swapPerson" (that replaces the person in a VIDEO).
- custom: runs ONE of the personal workflows of this installation (the cards below). It needs "customWorkflowId", copied EXACTLY from that list, and the card's own inputs in "customFields" when the user names values for them. "prompt" is what to draw, as in generate. Use it when the user asks for a card by its title or by what it does and no built-in action fits; if none of the cards does what they ask, queue NOTHING and say so.
- music: generates a separate audio track; "lyrics" is the sung text, optional. "seconds" ONLY if the user names a length (${String(MUSIC_MIN_SECONDS)}-${String(MUSIC_MAX_SECONDS)}): otherwise do NOT write it, the studio decides from the length of the text.
- redo: redoes ONE single shot of a music video that is already edited and reassembles the whole video. The shots are in the list of videos with their number in the name: "videoclip-abc123-03of10.mp4" is the 3rd of 10. "Redo clip 3", "I don't like the third one", "regenerate 3/10" = action redo with "source" = that file (copy its name from the list). In "prompt" write ONLY what has to change in that shot if the user says it (e.g. "she turns towards the camera"), otherwise leave it empty: without it, the clip is redone with the same beat. Do NOT use story for this: it would redo the whole video. If the user says the lip sync is off, the shots to redo are the ones in the list marked "weak lipsync": one redo for each, without asking which.
- resume: RESUMES a music video that stopped halfway (failed clips, a restart, memory ran out) without redoing the shots that are ready: it regenerates only the missing ones, discards the ones the song does not reach and reassembles the video. "Continue from where it stopped", "resume the music video", "finish the video", "don't start over" = action resume with "source" = any numbered clip of that music video taken from the list (e.g. the last one, "videoclip-abc123-10of21.mp4"), "prompt" empty. It can ALWAYS be resumed: never say the whole thing has to be redone and do NOT use story for this.
- voice: changes the voice of a track that is already there (it needs "source": an audio file or a VIDEO CLIP both work — from a clip the studio extracts the track by itself, so "change the voice of this clip" with a video in the chat is this action and NO audio file is asked for; if the user asks to change the voice, queue it and do NOT refuse: whether the clip has an audio track is said by the studio, you do not know; if the user says "this song" or "the track" without naming it, take the most recent audio from the list instead of asking). The music stays: the graph separates the voice, converts it and puts the backing back. On a CLIP the studio returns the CLIP with the new voice — the same starting video with the converted track over it, not an audio file to edit back in: do not tell the user there is anything to reassemble, and do not promise an audio file when they gave you a clip. "voice" is which voice to use, "pitch" the semitones: WRITE IT every time the user mentions a deeper or higher voice or semitones — "male voice"/"deeper" = "pitch": -12, "female voice"/"higher" = "pitch": 12, "twelve semitones down" = "pitch": -12.${voices.length === 0 ? '' : ` Voices available, to be copied exactly: ${voices}.`}
- speak: reads a text aloud and saves the audio file. No starting file: "prompt" carries the text to read, copied from the user's sentence. It is the right action for "read this text", "voice from text", "turn it into audio", "say it aloud", "I want a voice over". It is NOT "voice" (that changes the voice of an existing track) and it is not "music" (that sings).
  Every file the studio made carries next to its name HOW it was made (action, format…) and, if somebody already looked at it, what can be seen in it. "Redo these photos in 9:16" / "make them horizontal" = the same action of those files, changing ONLY what the user asks. Do NOT ask which photos: you have them below.

LOCAL CHANGES TO A PHOTO ("remove X", "add X", "move X", "change only X"):
- "remix" redraws the whole photo. Write "prompt" as ONE short imperative sentence that names only the part to change and what to do with it ("Remove the extra arm", "Put a red scarf around her neck"). Do NOT describe the rest of the photo and do NOT list what must stay — no clothing, no body, no pose, no background, no light: the studio adds the fixed sentence that asks for everything else to stay the same, and a list of that kind is read as a description of the scene and gets the scene redrawn.
- Never promise that the rest will come back identical: say the model will try to leave it as it is.
- When the user names WHERE to change and the photo is in the chat or the project, give a "region": the graph then edits that rectangle and leaves the rest of the photo as it is, which is what "solo la giacca", "only the face" or "the top-left corner" are asking for. Without one the whole photo is redrawn.
- When the user says the result is still wrong ("still there", "non l'hai rimosso", "ce ancora"), "source" is the photo that run STARTED from (its "from ..." in the list), never the failed result: a correction asked of the failed output adds to it instead of undoing it.
- After TWO failed attempts at removing the same thing, queue nothing: say in "reply" that a full redraw has already had its two tries, and that «Remove object» (IOPaint) paints the part out and fills only that area, leaving the rest identical; «Precise edit» is for changing a zone, not for removing. That is the right tool for a body part or an object lying over the body, not a refusal.

Parameters:
- aspect: one of ${IMAGINE_ASPECTS.join(', ')}. Vertical = 9:16, horizontal = 16:9, square = 1:1.
- resolution: one of ${IMAGE_RESOLUTIONS.join(', ')}. A video does not go past 720p.
- seconds: the length asked for, in seconds. video: any length from 5 to ${String(MAX_STORY_SECONDS)} (one take from one photo, chained past 6 s); story: 20-${String(MAX_STORY_SECONDS)}; loop: 5-${String(Math.max(...LOOP_SECONDS))}; music: ${String(MUSIC_MIN_SECONDS)}-${String(MUSIC_MAX_SECONDS)} and only if it is said; recreate: ignored, the clip decides.
- count: how many variants of the same prompt (1-4). Only for generate.
- source: the name of a file from the list below, when the sentence starts from something that is already there.
- sources: a list of image names, one per shot, for a music video cut between shots (story only). Copy them from the lists below, in the order they must appear.
- song: the name of an audio file ALREADY in the gallery, when the video is to be cut to that track (then the action is story).
- objectMode: only for objectSwap: one of change, remove, background, add (see its line above). Leave it out and the studio does "change".
- quality: only for a photo or a card: "high" when the user asks for the best quality, the most detail, or "alta qualità". Leave it out for the normal quality; "standard" is not a sentence.
- speed: only for a video: "slow" when the user asks for the high-quality/slower version, or "lenta". Leave it out for the fast one.
- upscaleTo: only for upscale: the short side to reach, one of 1080, 1440, 2160 for a photo and 720, 1080 for a clip. Leave it out when the user does not say a size: the studio raises to the next step.
- region: only for remix, when the user says WHERE to change ("only the jacket", "just the face", "the top left corner") and the photo is in the chat or the project. Give the rectangle as fractions of the photo: {"x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1}, x/y from the top-left corner. Leave it out for a change to the whole photo.
- customWorkflowId: only for custom, copied EXACTLY from the personal cards below. Never invent one.
- customFields: only for custom, an object with the card's own inputs, keyed "<node>.<field>" exactly as the card lists them, only the ones the user names a value for.
- lipSync: only for swapPerson: false when the people in the clip do NOT sing or talk along (music they only dance or move to), so the new person does not mouth the vocals. Leave it out otherwise: lip-sync is on.

Videos already have audio: the video model generates music, ambience and, IF YOU ASK IT, a voice too. But by itself it adds none: if the user does not talk about singing, speech or a text to sing, the video comes out with ambience and music only, with no voices. Never say the model "sings by itself" something the user did not ask for.

INSTAGRAM REELS AND STORIES:
"reel", "reels", "story"/"stories" for Instagram are not actions: they say WHERE the video goes. They are a format, and they work like this:
- "reel" = vertical 9:16, 720p, and the length needed (for a single clip it stays 5, 10 or 15). It means: action "video" (or "story" if they ask for more than 15 seconds or several moments), with "aspect": "9:16" and "resolution": "720p". If the user does not say the length, do NOT invent it: the clip stays the one it is.
- Publishing is not your job: that is done from the gallery. If the user says "publish", answer that the button is in the gallery and queue no intent.
- A reel does NOT have to sing just because it is a reel: put a voice only if the user asks for it ("singing", "with lip sync", "voice over", or quoting a text). A silent reel with music only is the normal case, not a mistake.
- Instagram keeps reels within 120 seconds: if the user asks for a longer reel, give it to them but say so in "reply".
- A reel animates something that is already there: if the user says "generate a reel" and there is no image in the chat or on the project, do NOT invent a source and do not queue "video" (it would fail with "it needs a starting image"). Leave "intents" empty and ask in "reply" which image to start from, or offer a "generate" first if they want the photo too.

Videos over a song: there are two ways, and the user chooses:
- the video itself sings the song: ONE single story action with "lyrics" (the text) and no music action. That is what they mean by "make the music with the video model" or "do it all with the video".
- the song is a separate track: first music, then story with "song" (but the audio file must already exist: if it is not there yet, ask or do the music only).
Do not answer that the video model cannot make the music: it can.

${request.defaults === undefined
  ? `What is not said must NOT be invented, but in this chat there are no buttons: format, resolution and length are decided by you. If the user does not say them, choose the ones that suit the subject best and write them in the intent, then say so in "reply" in your own words. Do not ask for them: decide.`
  : `What is not said must NOT be invented: leave it out and the current value applies (format ${request.defaults.aspect ?? '9:16'}, ${request.defaults.resolution ?? '720p'}, ${String(request.defaults.seconds ?? 5)} seconds).`}

${preset.length === 0 ? '' : `Composition chosen right now on the page, and not sent yet (it counts if the user says "this", "like that", "with this preset"): ${preset}.\n`}
${running}

${staged.length === 0 ? 'There are no files in the chat.' : `Files the user put in the chat:\n${staged}`}${sights.length === 0 ? '' : `\n\nWhat is really visible in those files (a vision model looked at them: this counts, not what you imagine):\n${sights}`}${eyes?.blind === true ? "\n\nYou CANNOT see those files: there is no model here that looks at them. If the user asks what is inside an image, say so openly — do not describe a file you have not seen." : ''}
${recent.length === 0 ? '' : `\nFiles of the project, by kind (the most recent first), with how they were made and what is visible when somebody already looked at them. A file with no "seen" has not been looked at yet: do not describe it. For a music video the shots are the IMAGES of this list and the song is one of the AUDIO:\n${recent}`}
${history.length === 0 ? '' : `\nConversation:\n${history}`}
${events.length === 0 ? '' : `\nRecent outcomes of the studio (the user did not write them, they are the results of the runs):\n${events}\nIf the user asks why something failed, the answer can only be here: read it and say it in your own words. If there is no error here, say so — you do not know, and the cause must not be invented.\nThey are outcomes of PAST runs, often on different files from the one the user has in the chat now: do not use them to say what a file of today does or does not contain. You do not know whether a clip has audio, which voice is inside it or what is heard — never state it, neither for nor against. When the user asks for a run, queue it: if it really cannot be done the studio refuses it, and the refusal appears here with its reason.`}

The user now writes:
"""
${request.text}
"""

${workflows.length === 0 && cards.length === 0 ? '' : `${workflows.length === 0 ? '' : `The ComfyUI workflows of this installation, which you may look at or change ONLY when the user explicitly asks to see or change a graph or one of its parameters:
${workflows}
`}${cards.length === 0 ? '' : `Personal cards you can run with "action": "custom" (id — title — description — inputs):
${cards}

`}If — and only if — the user explicitly asks to SEE or CHANGE a workflow or a parameter of it (for example "show me the graph of the image generation", "change the sampler steps to 20", "quanti nodi ha il workflow della musica"), reply with {"workflow": "<key>"} AND, in the same object, the "reply" and any "intents" the sentence itself asks for. On the next turn I will give you the nodes and the facts of that workflow and you will decide there. Never write "workflow" for an ordinary request to generate something: a sentence that asks for a picture, a video or a song is not a request to change a graph.

`}Reply ONLY with a JSON object, with no comments and no code blocks. A single object carries both things: the prose for the user and the runs that prose decided.
{"reply": "<the answer for the user, in prose>", "intents": [{"action": "...", "prompt": "...", ...}]}

Rules:
- "prompt" is what to generate, drawn from the user's sentence: take out the orders ("make me", "generate a 10-second video") and keep the content. Do not add details of your own.
- Empty "intents" when the sentence is a question, a clarification or a comment: then answer only in words in "reply".
- If something essential is missing (an image for a remix, a video for an extend) do not invent it: empty intents and ask for it in "reply".
- NEVER describe the content of a file that has not been described to you above: if the description is not there, you have not seen it, and saying so is the right answer.
- At most ${String(ceiling)} intents: ${String(MAX_INTENTS)} for the different things they ask for, plus one for every file they put in the chat when the same action applies to all of them.
- "N videos" (or "N clips") means N video intents, never fewer: "count" does not apply to videos. With N files in the chat and the same action for all of them (for example "regenerate the detail" with eight clips in the chat), one intent for EVERY file, each with its own "source": the ceiling above covers one file at a time. With fewer photos than videos, loop over the photos there are: with ONE photo in the chat, N video intents with that same photo as "source" (they are N variants). Do not ask for other images, do not reduce the number and do not hand the others back to the user: they already put the files in the chat.
- "reply" is an answer written in ${language}, not a label: 2-4 sentences of prose. Say what you understood of the request, what you are about to queue (action, quantity, format and length when they matter) and what the user will see. If you queue nothing, answer the question in full. Do not repeat the user's sentence word for word and do not start with "Got it".
- The prose and the intents are the same answer: when "intents" is not empty, "reply" explains what is starting, and whoever reads sees the words first and then the files that are the consequence of them.
- Do not write anything outside the JSON: no introduction, no list outside, no code block.`
}


/**
 * The instruction that turns a request about one workflow into changes.
 *
 * Written after the node list rather than before it: the model is choosing
 * among inputs that exist, and the only thing it may do to one is give it
 * another value of the same kind.
 * @param request - the line and the state it was written in.
 * @param entry - the workflow being looked at.
 * @param nodes - that workflow's editable inputs, node by node.
 * @returns the prompt sent to the reading model.
 */
function workflowChangeInstruction(
  request: ImagineChatRequest,
  entry: { readonly key: string; readonly label: string; readonly file: string; readonly description?: string },
  nodes: string,
  accepted: string,
  warnings: readonly string[],
): string {
  return `You are looking at the ComfyUI workflow "${entry.label}" (${entry.file}) of this installation.${entry.description === undefined ? '' : ` It is used for: ${entry.description}.`}

Nodes and editable values (id, node type, fields):
${nodes}
${accepted.length === 0 ? '' : `
What those inputs accept, read from the node definitions (a value outside this is refused by the studio, so do not write one):
${accepted}
`}${warnings.length === 0 ? '' : `
Pins that no longer resolve, which you must not try to write through:
${warnings.map(line => `- ${line}`).join('\n')}
`}
The user wrote:
"""
${request.text}
"""

Reply ONLY with a JSON object:
{"reply": "<what you did or understood, in the user's language>", "changes": [{"node": "<id>", "field": "<field>", "value": <new value>}]}

Rules:
- You may only change the value of a field you see in the list. Do not add nodes, do not add fields, do not touch the links between nodes: they are deliberately not in the list.
- The new value must be of the same kind as the one there now: a number for a number, text for text.
- Where a list of accepted values is given, copy one of them EXACTLY: an invented LoRA, checkpoint or model name is a run that fails after the queue.
- Where a number has bounds and a multiple, stay inside them and write a value on that multiple (a measure off the grid is refused).
- If the user is only asking how it is built, empty "changes" and explain it in "reply", citing the nodes by id.
- If what they ask cannot be done with these fields, empty "changes" and say so.
- At most ${String(MAX_CHANGES)} changes.`
}

/**
 * The constraints of a workflow's inputs, as one block of the second pass.
 *
 * A graph's JSON says what each value is now, not what it may be: the closed
 * list of a combo (the LoRAs and checkpoints this installation really has) and
 * the bounds and multiple of a number live in the node's Python. Written into
 * the prompt so the reading picks a value that exists, and checked again in
 * `planWorkflowPatch` so one that does not is refused rather than written.
 * @param fields - the workflow's editable inputs.
 * @param facts - what each input accepts, from ComfyUI.
 * @returns one line per constrained input, or an empty string when none is.
 */
function acceptedInputs(fields: readonly WorkflowField[], facts: readonly WorkflowFieldFact[]): string {
  const byKey = new Map(facts.map(fact => [`${fact.node}.${fact.field}`, fact]))
  const lines: string[] = []
  for (const field of fields) {
    const fact = byKey.get(`${field.node}.${field.field}`)
    if (fact === undefined) continue
    const bits: string[] = []
    if (fact.kind === 'combo' && (fact.options?.length ?? 0) > 0) {
      const options = fact.options ?? []
      const shown = options.slice(0, OPTIONS_IN_PROMPT)
      bits.push(`one of: ${shown.join(' | ')}${options.length > shown.length ? ` (+${String(options.length - shown.length)} more, not listed: do not invent one of them)` : ''}`)
    }
    if (fact.kind === 'number') {
      if (fact.min !== undefined || fact.max !== undefined) {
        bits.push(`range ${fact.min === undefined ? '-inf' : String(fact.min)}..${fact.max === undefined ? '+inf' : String(fact.max)}`)
      }
      if (fact.step !== undefined && fact.step > 0) bits.push(`multiple of ${String(fact.step)}`)
    }
    if (bits.length === 0) continue
    lines.push(`- ${field.node}.${field.field} (${field.classType}): ${bits.join(', ')}`)
  }
  return lines.join('\n')
}

/** The closed lists the workflows accept, and what the line was read with. */
interface ImagineChatCatalog {
  /** Voices the voice workflow accepts, as the RVC loader spells them. */
  readonly voices?: readonly string[]
  /**
   * How many runs this line may queue, when the caller knows better than the
   * constant: one per file the user staged in the chat.
   */
  readonly ceiling?: number
  /** The line the user wrote, for a title the reading left out. */
  readonly asked?: string
  /**
   * The staged files by name, for the shape a run starts from: a photo's
   * width and height decide the clip's frame when the sentence names none.
   */
  readonly files?: Readonly<Record<string, ImagineChatFile>>
  /** The personal cards a `custom` intent may name, by id. */
  readonly cards?: readonly WorkflowCard[]
}

/**
 * Snap one value to the catalogue that has to accept it.
 *
 * These are ComfyUI combo inputs: the node takes one of a fixed list and
 * rejects the whole graph otherwise, which the studio can only report as "il
 * workflow ha fallito la validazione". Case and spacing are forgiven because
 * the model is reading the list back to us; anything else is not on the list.
 * @param value - what the reading proposed.
 * @param list - what the workflow accepts, when this deployment published one.
 * @returns the catalogue's own spelling, or undefined when it is not on it.
 */
function listed(value: string | undefined, list: readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  if (list === undefined || list.length === 0) return value
  const wanted = value.trim().toLowerCase()
  return list.find(entry => entry.trim().toLowerCase() === wanted)
}

/**
 * The length a run will really render, from the length the sentence asked for.
 *
 * A reading writes a number, and the studio's ladders decide what reaches the
 * GPU: a 12-second clip is twelve seconds of chained scenes, a 400-second one
 * is the chain's ceiling, a 4-second one is the first rung. Keeping the
 * reading's raw number in the intent made the prose promise a length the file
 * would not have, so the intent carries the real one and the reply says it.
 * @param action - the action the run asks for.
 * @param resolution - the ladder step the run is on, when one was chosen.
 * @param seconds - what the sentence asked for.
 * @returns the length the studio will render, or undefined when none was asked.
 */
function secondsFor(
  action: ImagineAction,
  resolution: string | undefined,
  seconds: number | undefined,
): number | undefined {
  if (seconds === undefined) return undefined
  const whole = Math.round(seconds)
  const step = (resolution ?? '720p') as ImagineResolution
  switch (action) {
    case 'story':
      return clampStorySeconds(whole)
    case 'video':
    case 'extend':
      return clampSeconds('video', step, whole)
    case 'loop':
      return clampSeconds('loop', step, whole)
    case 'music':
      return Math.max(MUSIC_MIN_SECONDS, Math.min(MUSIC_MAX_SECONDS, whole))
    default:
      // A recreation, a redo and a resume take their length from the clip.
      return whole
  }
}

/**
 * A precise edit's zone, checked: fractions of the photo, inside the frame.
 * @param raw - what the reading wrote in `region`.
 * @returns the rectangle, or undefined when it is not one.
 */
function regionOf(raw: unknown): ImagineRegion | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const source = raw as Record<string, unknown>
  const x = finite(source['x'])
  const y = finite(source['y'])
  const w = finite(source['w'])
  const h = finite(source['h'])
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) return undefined
  return { x, y, w, h }
}

/**
 * A card's own inputs, as the run takes them: only the ones the card exposes,
 * and only values of the kind it declares.
 * @param raw - what the reading wrote in `customFields`.
 * @param card - the card the intent names.
 * @returns the values by `<node>.<field>`, or undefined when there is none.
 */
function customFieldsOf(
  raw: unknown,
  card: WorkflowCard | undefined,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (card === undefined || typeof raw !== 'object' || raw === null) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const input of card.inputs) {
    const value = (raw as Record<string, unknown>)[`${input.node}.${input.field}`]
    if (typeof value === 'string') {
      if (input.kind === 'text' || input.kind === 'combo' || input.kind === 'frame') out[`${input.node}.${input.field}`] = value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      if (input.kind === 'number') out[`${input.node}.${input.field}`] = value
    } else if (typeof value === 'boolean') {
      if (input.kind === 'boolean') out[`${input.node}.${input.field}`] = value
    }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Read one intent out of the model's object, dropping what it invented.
 *
 * Every field is checked against the ladders this deployment really has: a
 * ratio or a step that is not on the list is left out rather than sent, and
 * the client then keeps what the project was already using.
 * @param raw - one entry of the model's `intents`.
 * @param known - file names the studio actually has.
 * @param catalog - the closed lists the workflows accept.
 * @returns the intent, or undefined when it names no action this studio runs.
 */
function intentOf(
  raw: unknown,
  known: ReadonlySet<string>,
  catalog: ImagineChatCatalog = {},
): ImagineChatIntent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const entry = raw as Record<string, unknown>
  const action = textField(entry, 'action')
  if (action === undefined || !ACTIONS.includes(action as ImagineAction)) return undefined
  const aspect = textField(entry, 'aspect')
  const resolution = textField(entry, 'resolution')
  const source = textField(entry, 'source')
  const reference = textField(entry, 'reference')
  const song = textField(entry, 'song')
  const keepAudio = action === 'recreate'
    ? typeof entry['keepAudio'] === 'boolean' ? entry['keepAudio'] : undefined
    : undefined
  const lipSync = action === 'swapPerson' && entry['lipSync'] === false ? false : undefined
  /*
   * The light, only for `relight`: the id or the name (Italian or English) is
   * accepted and the id is kept; a light that does not exist is dropped here
   * and the server uses the first look, instead of failing the run.
   */
  const light = action === 'relight' ? relightLookOf(textField(entry, 'light'))?.id : undefined
  /*
   * An object swap's recipe, read for that action only: an invented value is
   * dropped here and the host falls back to `change`, the same rule as the
   * ladders — though the host refuses it at the POST too, because a cue like
   * "remove" that silently became a replacement would render the wrong edit.
   */
  const objectMode: ImagineObjectMode | undefined = action !== 'objectSwap'
    ? undefined
    : (IMAGINE_OBJECT_MODES as readonly unknown[]).includes(entry['objectMode'])
      ? entry['objectMode'] as ImagineObjectMode
      : undefined
  const lyrics = textField(entry, 'lyrics')
  // Same rule as `source`, per photo: an invented name would fail the shot it
  // was given to, in the middle of a queue the user is already waiting on.
  const sources = (Array.isArray(entry.sources) ? entry.sources : [])
    .filter((name): name is string => typeof name === 'string' && known.has(name))
  const secondsAsked = finite(entry['seconds'])
  const count = finite(entry['count'])
  const prompt = textField(entry, 'prompt')
  /*
   * The RVC loader takes one of the models it found on disk and rejects the
   * whole graph otherwise, so an unknown voice is dropped and the workflow's
   * own is used.
   */
  const voice = listed(textField(entry, 'voice'), catalog.voices)
  const pitch = finite(entry['pitch'])
  /*
   * A reel is vertical whatever the model forgot to write.
   *
   * The format is the one part of "reel" that is a fact rather than a choice:
   * Instagram renders it in the app's own frame, and a horizontal one is
   * cropped rather than refused. Asked of the model it held only as long as
   * the reply copied the instruction, so the format is derived from the user's
   * own line instead.
   *
   * The user's own words still win when they contradict the destination:
   * "un reel orizzontale" is a request that knows what it is asking for, and
   * silently flipping it to 9:16 would be the studio overruling the brief. The
   * test reads the user's line rather than the reply's field, because a model
   * told that reels are vertical fills the field itself and would keep the
   * contradiction invisible.
   *
   * A vertical frame is never imposed on a horizontal picture, though. The
   * word "reel" in a line about a 16:9 photo ("l'intro del canale, che sembra
   * un reel") used to turn the run portrait and letterbox the photo — the
   * destination is a fact, the source's shape is a bigger one.
   */
  const asked = catalog.asked ?? ''
  const vertical = wantsReel(asked)
    && !/\b(?:orizzontale|landscape|wide|16\s*:\s*9|quadrato|square|1\s*:\s*1)\b/i.test(asked)
  const sourceFile = source === undefined ? undefined : catalog.files?.[source]
  const aspectOfSource = sourceFile?.kind === 'image'
    ? aspectNearest(sourceFile.width, sourceFile.height)
    : undefined
  /*
   * The format, in this order: what the user said in words, the shape of the
   * picture being animated, what the reading chose, the vertical frame a reel
   * implies.
   *
   * The reading's own choice now counts (2026-11-04): with the composer's
   * buttons gone, nothing else can choose it, and dropping the field unless
   * the user spelled the ratio out made the prose say "16:9" while the run
   * came out 9:16. What the user says still wins over the reading — "un reel
   * orizzontale" is a brief that knows what it asks — and the source's shape
   * still wins over both, because a portrait canvas can only letterbox a
   * landscape still. Among the offered ratios the nearest holds a wide photo
   * whole; the resolution follows the frame: a reel is a phone frame at 720p
   * unless one was asked for.
   */
  const askedAspect = (IMAGINE_ASPECTS as readonly string[]).find(entry => namesRatio(asked, entry))
  const modelAspect = aspect !== undefined && (IMAGINE_ASPECTS as readonly string[]).includes(aspect)
    ? aspect as typeof IMAGINE_ASPECTS[number]
    : undefined
  const chosenAspect = askedAspect as typeof IMAGINE_ASPECTS[number] | undefined
    ?? aspectOfSource
    ?? modelAspect
    ?? (vertical ? '9:16' : undefined)
  const chosenResolution = resolution ?? (vertical && chosenAspect === '9:16' ? '720p' : undefined)
  /*
   * The two faces of the «Quality» pill: only the values the composer offers,
   * and only where the switch means something — a photo or a card buys
   * detail, a clip buys time. A reading that writes them for a redo or a
   * resume is asking for a control those runs do not have.
   */
  const quality = (action === 'generate' || action === 'remix' || action === 'compose' || action === 'custom')
    && typeof entry['quality'] === 'string' && (IMAGINE_QUALITIES as readonly string[]).includes(entry['quality'])
    ? entry['quality'] as ImagineQuality
    : undefined
  const speed = (action === 'video' || action === 'loop' || action === 'extend' || action === 'story')
    && typeof entry['speed'] === 'string' && (IMAGINE_SPEEDS as readonly string[]).includes(entry['speed'])
    ? entry['speed'] as ImagineSpeed
    : undefined
  /*
   * An upscale's target, on the ladder of the file's own kind. The source is
   * named by the sentence and its kind may be known from the staged files;
   * when it is not, both ladders are accepted and the host says no.
   */
  const upscaleSteps: readonly number[] = sourceFile?.kind === 'video'
    ? UPSCALE_VIDEO_STEPS
    : sourceFile?.kind === 'image' ? UPSCALE_IMAGE_STEPS : [...UPSCALE_IMAGE_STEPS, ...UPSCALE_VIDEO_STEPS]
  const upscaleAsked = finite(entry['upscaleTo'])
  const upscaleTo = action === 'upscale' && upscaleAsked !== undefined && upscaleSteps.includes(Math.round(upscaleAsked))
    ? Math.round(upscaleAsked)
    : undefined
  // A zone is a remix's business: every other run redraws or renders its own frame.
  const region = action === 'remix' ? regionOf(entry['region']) : undefined
  /*
   * A personal card, by the id the inventory lists. An id the studio does not
   * hold is kept here so the reading can say "not configured" instead of
   * queueing a run that would fail after the queue.
   */
  const customWorkflowId = action === 'custom' ? textField(entry, 'customWorkflowId') : undefined
  const card = customWorkflowId === undefined
    ? undefined
    : catalog.cards?.find(entry_ => entry_.id === customWorkflowId)
  const customFields = action === 'custom' ? customFieldsOf(entry['customFields'], card) : undefined
  const seconds = secondsFor(action as ImagineAction, chosenResolution, secondsAsked)
  return {
    action: action as ImagineAction,
    prompt: prompt ?? '',
    ...chosenAspect === undefined ? {} : { aspect: chosenAspect },
    ...chosenResolution !== undefined && IMAGE_RESOLUTIONS.includes(chosenResolution as (typeof IMAGE_RESOLUTIONS)[number])
      ? { resolution: chosenResolution }
      : {},
    ...seconds === undefined ? {} : { seconds: Math.round(seconds) },
    ...count === undefined ? {} : { count: Math.max(1, Math.min(4, Math.round(count))) },
    ...lyrics === undefined ? {} : { lyrics },
    ...voice === undefined ? {} : { voice },
    // Two octaves either way: past that a voice is not shifted, it is broken.
    ...pitch === undefined ? {} : { pitch: Math.max(-24, Math.min(24, Math.round(pitch))) },
    // A file the studio does not have is a hallucinated name, and sending it
    // would fail the run with a path error instead of using what is staged.
    ...source !== undefined && known.has(source) ? { source } : {},
    ...reference !== undefined && known.has(reference) ? { reference } : {},
    ...sources.length > 1 ? { sources } : {},
    ...song !== undefined && known.has(song) ? { song } : {},
    ...keepAudio === undefined ? {} : { keepAudio },
    ...lipSync === undefined ? {} : { lipSync },
    ...objectMode === undefined ? {} : { objectMode },
    ...light === undefined ? {} : { light },
    ...quality === undefined ? {} : { quality },
    ...speed === undefined ? {} : { speed },
    ...upscaleTo === undefined ? {} : { upscaleTo },
    ...region === undefined ? {} : { region },
    ...customWorkflowId === undefined ? {} : { customWorkflowId },
    ...customFields === undefined ? {} : { customFields },
  }
}

/**
 * Read the model's reply into a chat answer.
 * @param object - the JSON object of the reply, already pulled out of its fence.
 * @param known - file names the studio actually has.
 * @param catalog - the closed lists the workflows accept.
 * @returns the answer, or undefined when nothing usable came back.
 */
function parseImagineChat(
  object: Record<string, unknown> | undefined,
  known: ReadonlySet<string> = new Set(),
  catalog: ImagineChatCatalog = {},
): ImagineChatReply | undefined {
  if (object === undefined) return undefined
  const raw = object.intents
  const paired = (Array.isArray(raw) ? raw : [])
    .map(entry => ({ entry, intent: intentOf(entry, known, catalog) }))
    .filter((pair): pair is { readonly entry: unknown; readonly intent: ImagineChatIntent } => pair.intent !== undefined)
    .slice(0, catalog.ceiling ?? MAX_INTENTS)
  const intents = paired.map(pair => pair.intent)
  const reply = textField(object, 'reply')
  // A reply with neither a line nor a run is not an answer, and running the
  // fallback on the sentence is better than showing an empty bubble.
  if (reply === undefined && intents.length === 0) return undefined
  return { reply: [reply ?? '', realLengths(paired)].filter(line => line.length > 0).join(' '), intents, read: true }
}

/**
 * The sentence that tells the user the length the studio really renders.
 *
 * The reading chose a number, and the studio's ladders may have moved it: a
 * clip asked for 12 s is twelve seconds of chained scenes, a 400-second video
 * is the chain's ceiling, a 4-second one is the first rung. Without this the
 * prose kept the number the model wrote and the file came back another length,
 * with nothing in the chat to explain the difference.
 * @param pairs - the intents kept, with the entries the model wrote them in.
 * @returns one line naming the real lengths, or an empty string when none moved.
 */
function realLengths(pairs: readonly { readonly entry: unknown; readonly intent: ImagineChatIntent }[]): string {
  const lengths = new Set<number>()
  for (const { entry, intent } of pairs) {
    if (intent.seconds === undefined || typeof entry !== 'object' || entry === null) continue
    const asked = finite((entry as Record<string, unknown>)['seconds'])
    if (asked !== undefined && Math.round(asked) !== intent.seconds) lengths.add(intent.seconds)
  }
  if (lengths.size === 0) return ''
  return message('chat.realDuration', { seconds: [...lengths].map(seconds => String(seconds)).join(', ') })
}

/**
 * Give every run that came back without a prompt the line the user wrote.
 *
 * A music video is asked for as "fai il videoclip di questa canzone con le
 * foto del progetto": the song and the photos say what to render, so the
 * reading answers with an empty `prompt` — correctly, since there is nothing
 * left to describe. The studio then refused to start it, because a run with no
 * prompt is how the toolbar's own buttons say the user typed nothing, and the
 * sentence died as "serve un prompt" with no run and no explanation.
 * @param answer - the reading, as the model wrote it.
 * @param asked - the line the user actually wrote.
 * @returns the same answer, with every empty prompt filled in.
 */
function withAskedLine(answer: ImagineChatReply, asked: string): ImagineChatReply {
  const line = asked.trim()
  if (line.length === 0) return answer
  return {
    ...answer,
    intents: answer.intents.map(intent => (
      // A redo with nothing to change is asked for with an empty prompt: the
      // shot keeps its beat. The user's line ("rifai la clip 2") is not a beat.
      intent.action !== 'redo' && intent.action !== 'resume' && intent.prompt.trim().length === 0
        ? { ...intent, prompt: line }
        : intent
    )),
  }
}

/**
 * Apply the retry rules to what the reading queued, and say when a redraw has
 * had its two tries.
 *
 * The rules themselves are in `shared/imagine-edit.ts`, where they are tested
 * without a model; here they only meet the project's files and the sentence
 * that sends the user to the masked tool.
 * @param answer - the reading, as the model wrote it.
 * @param request - the line and the project's files.
 * @returns the same answer, with the sources and intents the rules allow.
 */
function retryEditAnswer(answer: ImagineChatReply, request: ImagineChatRequest): ImagineChatReply {
  const runs: EditRun[] = (request.recent ?? []).flatMap(file => file.made === undefined
    ? []
    : [{
      name: file.name,
      action: file.made.action,
      prompt: file.made.prompt,
      ...file.made.source === undefined ? {} : { source: file.made.source },
    }])
  const plan = retryEditIntents(answer.intents, runs, request.text)
  if (plan.escalated) return { ...answer, reply: message('chat.maskedRemoval'), intents: plan.intents }
  if (plan.rewound) return { ...answer, intents: plan.intents }
  return answer
}

/**
 * What the studio does with a line when no model is configured or it fails.
 *
 * Two paths. `failed` is a reader that was configured and did not answer: the
 * line is not run. Without `failed` it is the path "senza modello" — a
 * deployment with no chat model at all, which the reference setup never is (a
 * model is always configured) but is kept on purpose: the studio still runs a
 * line without one, as the toolbar did. The rules are the ones the toolbar
 * encoded: a clip needs a still, a continuation needs a clip, and everything
 * else is a generation. Nothing is read out of the sentence except which of
 * those it is, so the fallback can be wrong about the duration but never
 * about the shape of the run.
 * @param request - the line and the state it was written in.
 * @param failed - true when a configured reader did not answer.
 * @returns the run to queue, or the sentence that says why nothing runs.
 */
function fallbackImagineChat(request: ImagineChatRequest, failed = false): ImagineChatReply {
  const text = request.text.trim()
  /*
   * A reading that was configured and did not come back is not the toolbar's
   * behaviour, it is a failure, and running the line anyway spends the GPU on
   * a picture nobody asked for — measured on 2026-09-07: a song's lyrics came
   * back as an image of the lyrics, with no line in the chat saying why.
   */
  if (failed) {
    return {
      reply: message('chat.modelSilent'),
      intents: [],
      read: false,
      failed: true,
    }
  }
  const staged = request.staged ?? []
  const image = staged.find(file => file.kind === 'image')
  const video = staged.find(file => file.kind === 'video')
  const wantsVideo = /\bvideo\b|\bclip\b|\banima/i.test(text)
  const action: ImagineAction = video !== undefined
    ? 'extend'
    : wantsVideo && image !== undefined
      ? 'video'
      : image !== undefined
        ? 'remix'
        : 'generate'
  const source = video?.name ?? image?.name
  /*
   * A question is never generated. Without a reading every line became an
   * image of itself, so "perche' e' fallito?" came back as a picture of those
   * words — a run on the GPU, a file on the board and no answer. The studio
   * cannot answer it either with no model, but saying so costs nothing.
   */
  if (ASKED.test(text)) {
    return { reply: message('chat.unreadable'), intents: [], read: false }
  }
  return {
    reply: '',
    intents: text.length === 0 ? [] : [{ action, prompt: text, ...source === undefined ? {} : { source } }],
    read: false,
  }
}

/**
 * Ask the reading model one question, bounded and never throwing.
 * @param llm - the streaming surface.
 * @param target - the provider and model to read with.
 * @param instruction - the prompt.
 * @param say - the turn's own event sink, which already swallows a watcher
 *   that throws.
 * @param signal - stops the call when the chat closes.
 * @returns the reply, or undefined when it failed or said nothing.
 */
async function ask(
  llm: StreamCapable,
  target: { provider: string; model: string },
  instruction: string,
  say: ImagineChatWatcher,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // The reasoning is the thinking the studio never showed; the first write is
  // the only sign a route with no reasoning is answering at all, announced
  // once as a step.
  return streamText(llm, target, instruction, {
    ...signal === undefined ? {} : { signal },
    onReasoning: (text) => { say({ kind: 'reasoning', text }) },
    onWriting: () => { say({ kind: 'step', step: 'writing' }) },
  })
}

/** One change out of the model's `changes`, or undefined when it names none. */
function changeOf(raw: unknown): WorkflowChange | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const entry = raw as Record<string, unknown>
  const node = textField(entry, 'node')
  const field = textField(entry, 'field')
  const value = entry.value
  if (node === undefined || field === undefined) return undefined
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined
  return { node, field, value }
}

/**
 * Read the second pass into an answer about one workflow.
 *
 * A refusal is said out loud rather than left as an empty card: the user asked
 * for something this graph cannot do, and the reason is the answer.
 * @param text - the model's reply.
 * @param entry - the workflow being looked at.
 * @param inventory - what plans the changes.
 * @returns the answer, or undefined when nothing usable came back.
 */
function parseWorkflowReply(
  text: string | undefined,
  entry: { readonly key: string; readonly label: string; readonly file: string },
  inventory: WorkflowInventory,
  facts: readonly WorkflowFieldFact[] = [],
): ImagineChatReply | undefined {
  if (text === undefined) return undefined
  const object = jsonObjectOf(text)
  if (object === undefined) return undefined
  const reply = textField(object, 'reply')
  const spoken = reply === undefined ? undefined : { reply, intents: [], read: true }
  const raw = object.changes
  const changes = (Array.isArray(raw) ? raw : [])
    .map(entry_ => changeOf(entry_))
    .filter((change): change is WorkflowChange => change !== undefined)
    .slice(0, MAX_CHANGES)
  if (changes.length === 0) return spoken
  const plan = inventory.plan(entry.key, changes, facts)
  if (plan === undefined) return spoken
  const said = [reply ?? '', ...plan.diff.length === 0 ? plan.errors : []]
    .filter(line => line.length > 0).join(' ')
  if (plan.diff.length === 0) return said.length === 0 ? undefined : { reply: said, intents: [], read: true }
  return {
    reply: said,
    intents: [],
    read: true,
    proposal: {
      key: entry.key,
      label: entry.label,
      file: plan.file,
      diff: plan.diff,
      errors: plan.errors,
      warnings: plan.warnings,
    },
  }
}

/**
 * The words that make a line a request about a graph rather than a run.
 *
 * The second pass exists for "show me the graph", "change the sampler steps",
 * "which LoRA does this use". The model can name a workflow for any sentence,
 * and it did: an ordinary "fammi una foto" came back as a graph question. The
 * user's own words are the fact, so they are what opens the gateway.
 */
const WORKFLOW_TALK = /\b(?:workflow|grafo|graph|nodo|nodi|node|nodes|lora|sampler|campionatore|step|steps|passi|checkpoint|parametr[oi])\b/i

/**
 * Whether the user's line explicitly asks about a workflow or one of its
 * parameters: the graph words above, or the workflow's own key, label or card
 * title.
 * @param asked - the line as the user wrote it.
 * @param entry - the workflow the model named.
 * @returns true when the second pass may run.
 */
function asksAboutWorkflow(asked: string, entry: WorkflowSummary): boolean {
  if (WORKFLOW_TALK.test(asked)) return true
  const flat = asked.toLowerCase()
  const words = `${entry.key} ${entry.label} ${entry.card?.title ?? ''}`.toLowerCase().split(/[^a-z0-9]+/)
  return words.some(word => word.length >= 4 && flat.includes(word))
}

/** The sentence that says one action's graph is not configured here. */
function notConfigured(action: string): string {
  return message('chat.notConfigured', { action })
}

/**
 * Why one intent cannot run in this deployment, or undefined when it can.
 *
 * A run whose graph is not configured fails after the queue, with the GPU
 * waiting and a sentence about a workflow: the chat can see the list of
 * configured graphs, so it says it now and queues nothing. Only the graphs
 * that are required are checked; an action that has a fallback (a recreation
 * without its own graph renders on the video one) counts as available.
 * @param intent - the run the reading asked for.
 * @param inventory - the configured workflows and personal cards.
 * @returns the sentence to say, or undefined.
 */
function missingGraph(intent: ImagineChatIntent, inventory: WorkflowInventory): string | undefined {
  if (intent.action === 'custom') {
    const id = intent.customWorkflowId
    if (id === undefined) return message('chat.customNoCard')
    return (inventory.cards ?? []).some(card => card.id === id)
      ? undefined
      : message('chat.cardNotConfigured', { id })
  }
  const configured = (run: string): boolean => inventory.list.some(entry => entry.run === run)
  switch (intent.action) {
    case 'remix':
      // A zone change needs the graph that keeps the rest of the photo; a
      // full redraw can run on either.
      return intent.region === undefined
        ? configured('edit') || configured('editRegion') ? undefined : notConfigured(intent.action)
        : configured('editRegion') ? undefined : message('job.preciseEditNotConfigured')
    case 'upscale':
      return configured('upscaleImage') || configured('upscaleVideo') || configured('upscaleVideoLong')
        ? undefined
        : notConfigured(intent.action)
    case 'recreate':
      return configured('recreateVideo') || configured('video') ? undefined : notConfigured(intent.action)
    case 'video':
      return configured('video') || configured('videoChain') ? undefined : notConfigured(intent.action)
    case 'loop':
      return configured('loopVideo') || configured('loopChain') ? undefined : notConfigured(intent.action)
    case 'extend':
      return configured('extendVideo') || configured('extendChain') ? undefined : notConfigured(intent.action)
    case 'story':
      return configured('videoOnSong') ? undefined : notConfigured(intent.action)
    case 'objectSwap': {
      const mode = intent.objectMode ?? 'change'
      const run = mode === 'change' ? 'objectSwap'
        : mode === 'remove' ? 'objectSwapRemove'
          : mode === 'background' ? 'objectSwapBackground'
            : 'objectSwapAdd'
      return configured(run) || mode === 'add' && configured('objectSwapAddPhoto') ? undefined : notConfigured(intent.action)
    }
    case 'swapPerson':
      return configured(intent.lipSync === false ? 'swapPersonNoLipSync' : 'swapPerson')
        ? undefined
        : notConfigured(intent.action)
    default: {
      const runs = ACTION_RUNS[intent.action]
      // speak is not a graph: it is the speech service, and its own check runs there.
      if (runs === undefined) return undefined
      return configured(runs.workflow) ? undefined : notConfigured(intent.action)
    }
  }
}

/**
 * Drop the runs this deployment cannot start, and say why.
 * @param answer - the reading.
 * @param inventory - the configured workflows and personal cards.
 * @returns the same answer with only the runnable intents, and the refusal
 *   sentences added to its prose.
 */
function availableIntents(answer: ImagineChatReply, inventory: WorkflowInventory | undefined): ImagineChatReply {
  if (inventory === undefined) return answer
  const kept: ImagineChatIntent[] = []
  const refused: string[] = []
  for (const intent of answer.intents) {
    const reason = missingGraph(intent, inventory)
    if (reason === undefined) kept.push(intent)
    else refused.push(reason)
  }
  if (refused.length === 0) return answer
  return {
    ...answer,
    intents: kept,
    reply: [answer.reply, ...refused].filter(line => line.trim().length > 0).join(' '),
  }
}

/**
 * Attach to every file what the host has filed about it.
 * @param request - the line and the state it was written in.
 * @returns the same request, its files carrying their origin and sight.
 */
async function withNotes(request: ImagineChatRequest): Promise<ImagineChatRequest> {
  const files = [...request.staged ?? [], ...request.recent ?? []]
  if (files.length === 0) return request
  // One read of each note; a look whose note was not there yet is taken from
  // memory, never read from disk a second time.
  const notes = await recallNotes(files.map(file => file.name))
  const annotate = (file: ImagineChatFile): ImagineChatFile => {
    const origin = notes.get(file.name)?.origin
    const seen = notes.get(file.name)?.sight ?? sightInMemory(file.name)
    return {
      ...file,
      ...origin === undefined ? {} : { made: origin },
      ...seen === undefined ? {} : { seen },
    }
  }
  return {
    ...request,
    ...request.staged === undefined ? {} : { staged: request.staged.map(annotate) },
    ...request.recent === undefined ? {} : { recent: request.recent.map(annotate) },
  }
}

/**
 * Give the reader the shape of the files it is about to animate.
 *
 * The header read costs a file open and a few KB, and it is what tells "this
 * photo is horizontal" apart from "this photo is vertical": without it a
 * 1920x1080 still animated with nothing said about the frame came back on a
 * 9:16 canvas, letterboxed top and bottom.
 *
 * Only the staged files: they are the ones a run starts from (`filesByName`),
 * and the board's recent files were measured on every line for nothing — the
 * instruction never prints a shape.
 * @param request - the line, its files carrying what the host filed about them.
 * @param outputDir - the media directory; without one nothing is read.
 * @returns the request, its staged files carrying a shape where the header has one.
 */
async function withShapes(request: ImagineChatRequest, outputDir: string | undefined): Promise<ImagineChatRequest> {
  if (outputDir === undefined || request.staged === undefined) return request
  const shape = async (file: ImagineChatFile): Promise<ImagineChatFile> => {
    if (file.width !== undefined || file.height !== undefined || file.kind === 'audio') return file
    const safe = safeBasename(file.name)
    if (safe === undefined) return file
    const pixels = await probePixels(join(outputDir, safe), file.kind).catch(() => ({}))
    return 'width' in pixels && 'height' in pixels ? { ...file, width: pixels.width, height: pixels.height } : file
  }
  return { ...request, staged: await Promise.all(request.staged.map(shape)) }
}

/**
 * The staged files by name, for the format a run starts from.
 * @param request - the line's files, shape already read.
 * @returns the map the reading looks a `source` up in.
 */
function filesByName(request: ImagineChatRequest): Record<string, ImagineChatFile> {
  const byName: Record<string, ImagineChatFile> = {}
  for (const file of request.staged ?? []) byName[file.name] = file
  return byName
}

/**
 * Read one written line into the runs it asks for.
 *
 * Never throws and never queues anything itself: the studio starts the runs,
 * so a reading that comes back late, empty or malformed degrades to the
 * fallback — the line generated as it was written — instead of a failed turn.
 * @param ctx - plugin context, carrying `auxiliary` and `llm` when set up.
 * @param request - the line and the state it was written in.
 * @param inventory - the workflows this deployment loaded, when it has any.
 * @param outputDir - the media directory, for readings that look at files.
 * @param watch - an optional observer of the turn's events.
 * @param signal - stops the reading when the chat closes its stream.
 * @returns what to say and what to queue.
 */
export async function readImagineChat(
  ctx: ImagineHost,
  request: ImagineChatRequest,
  inventory?: WorkflowInventory,
  outputDir?: string,
  watch?: ImagineChatWatcher,
  signal?: AbortSignal,
): Promise<ImagineChatReply> {
  /** Tell the chat what is happening; a watcher that throws is ignored. */
  const say = (event: ImagineChatEvent): void => {
    try {
      watch?.(event)
    } catch { /* the chat is watching, not driving. */ }
  }
  // A deployment with no chat model still runs the line, as the toolbar did.
  const llm: StreamCapable | undefined = ctx.llm
  /*
   * The model the composer is showing answers the chat, then Imagine's own,
   * then the last one the chip showed: the control promises a model, and the
   * reading runs on it (see imagine-models).
   */
  const routes = textRoutes(request.model)
  const target = routes[0]
  if (target === undefined || llm === undefined || typeof llm.stream !== 'function') {
    // No reader at all: the line runs as the toolbar would have run it. That
    // is the deployment's behaviour, not a failure, so it is not announced as
    // one.
    return fallbackImagineChat(request)
  }
  const known = new Set([...request.staged ?? [], ...request.recent ?? []].map(file => file.name))
  /*
   * A model that cannot answer — an image model, a route that is down — hands
   * the line to the next candidate rather than to the fallback, which would
   * generate the sentence instead of reading it.
   */
  /*
   * The stills staged in the chat are looked at before the line is read. The
   * reading is a text call: given a name and a kind it described the picture
   * anyway, so "questa foto" was answered out of imagination. Reading them is
   * one vision call per file, remembered for the life of the process.
   */
  const stills = (request.staged ?? []).filter(file => file.kind === 'image')
  if (outputDir !== undefined && stills.length > 0) say({ kind: 'step', step: 'sight', count: stills.length })
  /*
   * The header probes of the staged files do not depend on the sights, so
   * they run while the vision pass does instead of after it.
   */
  const [eyes, shaped] = await Promise.all([
    outputDir === undefined || (request.staged ?? []).length === 0
      ? { sights: [], blind: false }
      : lookAtStaged(ctx, outputDir, request.staged ?? [], {
        ...request.language === undefined ? {} : { language: request.language },
      }),
    withShapes(request, outputDir),
  ])
  /*
   * What the host has on file about every file in front of the reading: how
   * it was made, and what was seen in it when something already looked. The
   * board's own files are never looked at here — a line would wait on forty
   * vision calls — they were queued for a look when they arrived. After the
   * sights: a look just taken is read from memory (`sightInMemory`).
   */
  /*
   * One read of the notes, for the instruction and for the retry rules: the
   * rules need each file's origin (what made it, from what), and reading the
   * same notes twice would also disagree with itself if a note landed between
   * the two reads.
   */
  const noted = await withNotes(shaped)
  const instruction = imagineChatInstruction(noted, inventory, eyes)
  let written: string | undefined
  // The route that answered, which the workflow pass below asks again: the
  // first route may be the one that did not.
  let answered = target
  for (const route of routes) {
    // Which model is answering, said out loud: the studio's select and
    // Imagine's own can be different models, and a line read by the second
    // looked exactly like a line read by the first.
    say({ kind: 'step', step: route === target ? 'route' : 'retry', detail: `${route.provider}/${route.model}` })
    written = await ask(llm, route, instruction, say, signal)
    answered = route
    // Stopped by the user: the next model would answer a chat that left.
    if (written !== undefined || signal?.aborted === true) break
  }
  /*
   * A line about a workflow costs a second call. The node lists are small, but
   * carrying every one of them on every sentence would put a few thousand
   * tokens of graph behind "fammi una foto".
   */
  // Parsed once: the workflow check and the reading below share it.
  const object = jsonObjectOf(written)
  const catalog: ImagineChatCatalog = {
    asked: request.text,
    ceiling: intentCeiling(request.staged ?? []),
    files: filesByName(shaped),
    ...request.voices === undefined ? {} : { voices: request.voices },
    ...inventory?.cards === undefined ? {} : { cards: inventory.cards },
  }
  const first = parseImagineChat(object, known, catalog)
  /*
   * The gateway to the workflow pass, in this order: the model named a
   * configured workflow, AND the user explicitly asked to see or change a
   * graph (or named that workflow's own words). A model that answers an
   * ordinary request with a workflow key is not answering the sentence: its
   * intents are the answer, and the gateway is ignored instead of hijacking
   * "fammi una foto" into a graph.
   */
  const askedKey = object === undefined ? undefined : textField(object, 'workflow')
  const entry = askedKey === undefined ? undefined : inventory?.list.find(item => item.key === askedKey)
  if (entry !== undefined && inventory !== undefined && asksAboutWorkflow(request.text, entry)) {
    say({ kind: 'step', step: 'workflow', detail: entry.card?.title ?? entry.label })
    const nodes = inventory.summarise(entry.key)
    const facts = await inventory.facts(entry.key, signal).catch(() => undefined) ?? []
    const fields = inventory.fields(entry.key) ?? []
    const warnings = inventory.warnings(entry.key) ?? []
    const instruction = nodes === undefined
      ? undefined
      : workflowChangeInstruction(request, entry, nodes, acceptedInputs(fields, facts), warnings)
    const graph = instruction === undefined
      ? undefined
      : parseWorkflowReply(await ask(llm, answered, instruction, say, signal), entry, inventory, facts)
    /*
     * The runs the first pass queued travel with the graph answer: a sentence
     * that asks for a photo and also asks about a graph does both, and the
     * reading's intents are never thrown away for a proposal.
     */
    const kept = first === undefined ? undefined : availableIntents(first, inventory)
    if (graph === undefined) {
      /*
       * The line was about a workflow, and the fallback below is a generation:
       * a second pass that comes back unreadable would turn "quanti step fa il
       * campionatore?" into an image of that sentence. It says so instead,
       * keeping whatever the first pass did queue.
       */
      const unreadable = message('chat.workflowUnreadable', { label: entry.card?.title ?? entry.label })
      if (kept === undefined) return { reply: unreadable, intents: [], read: true }
      return { ...kept, reply: [kept.reply, unreadable].filter(line => line.trim().length > 0).join(' ') }
    }
    /*
     * The same two fixes the plain answer gets: a run whose prompt came back
     * empty takes the sentence, and the retry rules still apply. Only the
     * shape of the answer is different — it also carries the proposal.
     */
    return withAskedLine(retryEditAnswer({
      ...graph,
      intents: kept?.intents ?? [],
      reply: [kept?.reply ?? '', graph.reply].filter(line => line.trim().length > 0).join(' '),
    }, noted), request.text)
  }
  const answer = first === undefined ? undefined : availableIntents(first, inventory)
  if (answer !== undefined) return withAskedLine(retryEditAnswer(answer, noted), request.text)
  /*
   * A reader was configured and the line still was not read: either nothing
   * came back or what came back is not an answer. Both are failures of the
   * reading and neither is a reason to generate the sentence.
   */
  say({ kind: 'step', step: 'fallback' })
  return fallbackImagineChat(request, true)
}
