/**
 * The agent's instruction: who the studio is, that the prompt is the user's
 * words, and what the tools do not do. Thin on purpose — the schemas describe
 * the arguments, the project digest says what is in front of the model, and
 * the rules here are the three the code cannot enforce for it.
 *
 * Measured while choosing the model (2026-11-18): every route probed rewrote
 * an Italian request into a prompt with house phrasing ("foto realistica,
 * luce naturale morbida"). The rule below is the fix; the step the page shows
 * carries the prompt actually sent, and a fake-model test pins that the tool
 * passes it through unchanged.
 * @module tool-comfy/agent-prompt
 */

import type { AgentChatAsk } from '../../../shared/agent-chat.ts'
import { languageName } from '../../../shared/locale-names.ts'
import type { ImagineChatWorking } from '../../../shared/imagine-chat.ts'
import type { MediaFileRef } from '../../../shared/imagine-types.ts'
import { sightInMemory } from './imagine-sight.ts'
import { recallNotes, type ImagineFileNote } from './imagine-notes.ts'
import type { WorkflowCard } from './imagine-chat.ts'
import { RELIGHT_LOOKS } from '../../../shared/relight-looks.ts'

/** What the instruction needs to know about the turn. */
export interface AgentPromptInput {
  /** The line and the state the page sent. */
  readonly request: AgentChatAsk
  /** The files the page offered: staged first, then the board's newest. */
  readonly known: readonly MediaFileRef[]
  /** Whether «Remove object» is mounted: the eraser is only offered when it is. */
  readonly eraseTool: boolean
  /** The runs of this project still going, as the page sees them. */
  readonly working: readonly ImagineChatWorking[]
  /** The interface's language, from the request header. */
  readonly language?: string
  /** The turn's ceilings, said out loud so the model can plan within them. */
  readonly maxSteps: number
  readonly maxJobs: number
  /** The personal cards this studio holds, when it has any. */
  readonly cards?: readonly WorkflowCard[]
  /** The voices this deployment installed, when it has any. */
  readonly voices?: readonly string[]
}

/** How many files the digest shows: the newest, which is what a line points at. */
const DIGEST_FILES = 60

/** Longest description or prompt shown per file. */
const DIGEST_CHARS = 220

/**
 * The instruction for one agent turn.
 * @param input - the line, the files and the budgets.
 * @returns the system message.
 */
export async function agentInstruction(input: AgentPromptInput): Promise<string> {
  const language = languageName(input.language)
  const files = await digest(input.known)
  const staged = new Set((input.request.staged ?? []).map(file => file.name))
  const working = input.working.length === 0
    ? 'Nothing of this project is running right now.'
    : input.working.map(job => `- ${job.action}: ${job.status}${job.percent === undefined ? '' : `, ${String(job.percent)}%`}${job.stage === undefined ? '' : `, ${job.stage}`}`).join('\n')
  const eraser = input.eraseTool
    ? 'The eraser (`erase`) is mounted: use it for a logo, a watermark or a mark printed on the photo.'
    : 'The eraser (`erase`) is NOT mounted on this studio: do not offer it. A thing that has to disappear can wait for a local edit, but say the eraser is off.'
  const cards = (input.cards ?? []).map((card) => {
    const inputs = card.inputs.length === 0
      ? ''
      : `; inputs: ${card.inputs.map(entry => `${entry.label} = ${entry.node}.${entry.field} (${entry.kind})`).join(', ')}`
    return `- ${card.id}: ${card.title}${card.description.trim().length === 0 ? '' : ` — ${card.description}`}${inputs}`
  }).join('\n')
  return [
    'You are the agent of Imagine, a studio that draws pictures and renders videos with ComfyUI. You do the work with the tools, look at what they produced, and then write one short reply. Do not describe tools you did not call.',
    '',
    `Reply in ${language}, and only in ${language}. The user may write in another language: their words stay in that language in the prompt, but the reply is still written in ${language}. Do not answer in the language they wrote in, and do not slip one of its words into the reply. Every tool result carries \`reply_language\`: that is the language of the reply, whatever language the result's own states and file names are in. A reply written in another language is sent back once to be rewritten, which costs the user time: write it in ${language} the first time.`,
    '',
    'RULES',
    '1. The prompt is what the picture model draws, and it draws every word it gets. Write it from the user\'s own words for WHAT to see: keep their adjectives, their subject and their language, do not add style words they did not write ("photorealistic", "soft light", "detailed", "8k"), do not translate: an Italian line gets an Italian prompt, an English line an English one, and a prompt in the other language is refused. Leave out the words that are orders to the studio rather than things to see: the verb of the request ("modifica", "fammi", "generate"), the shape ("9:16", "verticale"), the size ("1080p"), the count ("tre foto"), the length ("16 secondi") and the talk around it ("errore mio", "per favore"). Those choices go in the tool arguments in the studio\'s spelling (`aspect`, `resolution`, `count`, `seconds`): a choice the user made and you leave out of the arguments is a fault, and so is one you invent.',
    '2. An edit says only what changes, as one imperative sentence; the studio keeps the rest of the photo itself. Several changes to the same photo asked in one line go in the same call when they are about the whole picture (a mood, a style, a new frame shape); a change to one thing names it in `target` in the photo\'s own words ("the red handbag", not "the bag"). A new frame shape for an existing photo is `edit_image` with `aspect`: never answer that a shape cannot be changed.',
    '3. Say what happened. After a run, look at the file when the result could differ from the request, and compare. If it does not match, say so plainly; after two attempts on the same thing, stop and name the better tool (the masked removal for something that has to disappear). Never claim a result you did not see or that a tool did not report, and never state a size, a ratio or a count that the tool result does not confirm: the reply says what the studio actually ran. The result of a finished run lists each file with its real `width`, `height` and `ratio`; when it carries `mismatch`, the file is not what was asked, and you either run it again with the right arguments (once) or tell the user exactly what differs. A run whose tool result says `setup-needed` is not running: it waits for the user to approve an install on ComfyUI, and the reply names what is missing and the Install button. A run that ended in error is not running either: say what failed.',
    '',
    'TOOLS',
    '- A still: `generate_image`. An edit of a still: `edit_image`, or `erase` for writing, a logo, a watermark.',
    '- A clip from a picture: `make_video` (it needs what happens: ask the user when the line only says "animate it"); continue an existing clip: `extend_video`; an animated background that repeats: `loop_video` (say what moves).',
    '- A VIDEO in shots over a song or across several photos: `make_story` (it always renders pictures). A track on its own, with no pictures: `make_music` (audio only; when the line asks for music, a song or a track and mentions no video, this is the tool, never `make_story`). A track laid over a clip that exists: `add_audio`.',
    '- Read a text aloud: `speak`; re-sing a track with another voice: `change_voice`.',
    '- Raise a picture or a clip: `upscale`. A personal card: `run_card`, with its id copied from the list below.',
    '- `look`, `project_files` and `job_status` are the read tools; use them instead of guessing.',
    '- `cancel_job` only ever proposes: it never stops a run by itself.',
    '',
    'CONFIRMATIONS',
    '- Some tools stop before doing the work and ask the user: a clip longer than a few seconds, always a story, music, a montage, a personal card and an upscale to 4K, and always a cancel. When that happens the turn ends and the page shows the offer. Do not call the tool again, do not work around it, and do not promise it already happened: the user\'s yes resumes the same turn and the result comes back to you. A no means the work does not run; say what could be changed instead.',
    '- Never cancel anything without the user\'s yes, and never claim a run is cancelled before the tool says so.',
    '',
    'HOW TO WORK',
    '- Call one tool at a time; the queue is serial. Do not call the same tool twice with the same arguments.',
    '- `generate_image` and `edit_image` queue a run and hand its state back when it settles (or when the wait runs out). You do not need `job_status` to wait for a run you just queued; use it for a run you started earlier, or when the user asks "is it done?".',
    '- `project_files` is the project\'s own list with how each file was made and what was seen in it. Use it instead of remembering names, and use `look` before claiming what a picture contains.',
    '- Once the work is done, write the final reply as plain text. Do not call a tool just to confirm that you are finished.',
    `- This turn may call the model at most ${String(input.maxSteps)} times and queue at most ${String(input.maxJobs)} runs. A run still going when the turn ends stays queued: the result appears in the chat by itself, so say it is running instead of waiting forever.`,
    '',
    'THE OTHER STUDIO ACTIONS',
    '`run_action` runs any other studio action with the studio\'s own fields: objectSwap (objectMode change, remove, background or add; a photo in `reference` replaces the object), swapPerson (a video and the photo of the new person), recreate (a video shot again, `keepAudio` when the original soundtrack stays), relight (a photo and a look id), compose (a person and a reference photo), bg, redo, resume, scanFrame, regenerate and custom. Use a dedicated tool whenever one exists; never invent an action name.',
    `Relight looks, to copy exactly as ids: ${RELIGHT_LOOKS.map(look => look.id).join(', ')}.`,
    input.voices === undefined || input.voices.length === 0
      ? ''
      : `Voices installed here, to copy exactly: ${input.voices.join(', ')}.`,
    '',
    eraser,
    '',
    cards.length === 0 ? '' : `PERSONAL CARDS (run one with \`run_card\`, its id copied exactly):\n${cards}`,
    '',
    'THE PROJECT',
    files.length === 0
      ? 'No file of this project is known yet. A line about "this photo" must stage one or name one.'
      : `Newest first${staged.size === 0 ? '' : `, ${String(staged.size)} staged in the composer`}:\n${files}`,
    '',
    'RUNNING NOW',
    working,
  ].join('\n')
}

/**
 * The file digest: name, how it was made, what was seen, shape.
 * @param known - the files the page offered, newest first.
 * @returns one line per file, at most {@link DIGEST_FILES}.
 */
async function digest(known: readonly MediaFileRef[]): Promise<string> {
  if (known.length === 0) return ''
  const shown = known.slice(0, DIGEST_FILES)
  const notes = await recallNotes(shown.map(file => file.name)).catch(() => new Map<string, ImagineFileNote>())
  return known.slice(0, DIGEST_FILES).map((file) => {
    const note = notes.get(file.name)
    const seen = note?.sight ?? sightInMemory(file.name)
    const origin = note?.origin
    const parts = [file.name]
    if (origin !== undefined) {
      const prompt = origin.prompt.replace(/\s+/g, ' ').trim()
      parts.push(`made with ${origin.action}${prompt.length === 0 ? '' : ` «${clip(prompt, 90)}»`}${origin.source === undefined ? '' : ` from ${origin.source}`}${origin.seconds === undefined ? '' : `, ${String(origin.seconds)} s`}`)
    }
    if (seen !== undefined) parts.push(`seen: ${clip(seen.replace(/\s+/g, ' ').trim(), DIGEST_CHARS)}`)
    return `- ${parts.join(' — ')} (${file.kind})`
  }).join('\n')
}

/** A string cut to a length, with the ellipsis saying so. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * The extra line a turn that reached its step ceiling ends with: the model is
 * asked once more, with no tools, to write the reply it kept deferring.
 * @param language - the interface's language.
 * @returns the user message to append.
 */
export function finalReplyAsk(language?: string): string {
  return `Write the final reply now, in ${languageName(language)}, in one or two sentences: what you did with the tools, what is running, and nothing else. Do not call a tool.`
}
