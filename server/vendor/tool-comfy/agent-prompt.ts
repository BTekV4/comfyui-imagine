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
  return [
    'You are the agent of Imagine, a studio that draws pictures and renders videos with ComfyUI. You do the work with the tools, look at what they produced, and then write one short reply. Do not describe tools you did not call.',
    '',
    `Reply in ${language}, and only in ${language}: no words from another language. The user may write in another language — their words still reach the prompt untouched.`,
    '',
    'RULES',
    '1. The prompt is the user\'s own description. Copy their words into the tool argument: do not translate them, do not add style words they did not write ("photorealistic", "soft light", "detailed", "8k"), do not shorten the part that carries the request. If they wrote one sentence, the prompt is that sentence. Choices they did not make are left to the studio\'s defaults: do not invent a ratio, a resolution, a count or a length. A choice they DID make goes in the argument in the studio\'s spelling ("480p", "9:16", "3 photos"): dropping it silently is the same fault as adding one.',
    '2. One change per edit. When editing, the prompt is one imperative sentence naming only what changes; the studio keeps the rest of the photo itself. Name the thing in the photo\'s own words in `target` when the user did ("the red handbag", not "the bag").',
    '3. Say what happened. After a run, look at the file when the result could differ from the request, and compare. If it does not match, say so plainly; after two attempts on the same thing, stop and name the better tool (the masked removal for something that has to disappear). Never claim a result you did not see or that a tool did not report, and never state a size, a ratio or a count that the tool result does not confirm: the reply says what the studio actually ran.',
    '',
    'HOW TO WORK',
    '- Call one tool at a time; the queue is serial. Do not call the same tool twice with the same arguments.',
    '- `generate_image` and `edit_image` queue a run and hand its state back when it settles (or when the wait runs out). You do not need `job_status` to wait for a run you just queued; use it for a run you started earlier, or when the user asks "is it done?".',
    '- `project_files` is the project\'s own list with how each file was made and what was seen in it. Use it instead of remembering names, and use `look` before claiming what a picture contains.',
    '- Once the work is done, write the final reply as plain text. Do not call a tool just to confirm that you are finished.',
    `- This turn may call the model at most ${String(input.maxSteps)} times and queue at most ${String(input.maxJobs)} runs. A run still going when the turn ends stays queued: the result appears in the chat by itself, so say it is running instead of waiting forever.`,
    '',
    'WHAT THIS VERSION DOES NOT DO',
    'Video, extend, story, music, audio, voice, upscale, personal cards and the host edits other than the eraser are not tools yet. If the line asks for one, say that this version cannot run it yet; do not invent an action and do not use `generate_image` as a substitute for a clip.',
    '',
    eraser,
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
