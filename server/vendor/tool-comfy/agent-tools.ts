/**
 * The agent's tools: what the model may ask the studio to do, the arguments it
 * may pass, and the executor of each.
 *
 * Every tool reuses the path the page and the MCP already use — a run goes
 * through `startFromBody` (`job-start.ts`), a look through the same vision
 * client and sight cache, a project file through the same gallery and notes.
 * Arguents are validated, never restyled: a ratio off the ladder, a name that
 * is not in the gallery, a zone past the edge is refused with a sentence the
 * model can correct. The prompt is the user's words, passed as they arrived.
 *
 * F1 covers a still, an edit, the masked removal, a look, the project's files
 * and a run's state. Everything that renders a clip is F2; a line asking for
 * one is told so instead of being answered with an invented action.
 * @module tool-comfy/agent-tools
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { message } from '../../src/messages.ts'
import { ERASE_FEATHER, grownRegion } from '../../../shared/imagine-grounding.ts'
import {
  IMAGE_RESOLUTIONS, IMAGINE_ASPECTS, UPSCALE_IMAGE_STEPS, UPSCALE_VIDEO_STEPS,
  type ImagineAspect, type ImagineResolution,
} from '../../../shared/imagine-media.ts'
import { VIDEO_RESOLUTIONS, megapixelsFor, sizeFor, videoAspectLabel } from '../../../shared/imagine-sizing.ts'
import type { ImagineChatEvent } from '../../../shared/imagine-chat.ts'
import {
  IMAGINE_ACTIONS, type GalleryItem, type ImagineAction, type ImagineJobView, type ImagineRegion,
  type MediaFileRef, type ModelRoute,
} from '../../../shared/imagine-types.ts'
import type { AgentToolSchema } from '../../../shared/agent-chat.ts'
import { languageName } from '../../../shared/locale-names.ts'
import { languageOfPrompt } from './reply-language.ts'
import { featherMask, maskDataUrl, rectangleMask } from '../../../shared/masks.ts'
import { frameAt } from './media-tools.ts'
import { galleryItemOf, kindOf, listGallery, safeBasename } from './gallery.ts'
import { groundTarget } from './grounding.ts'
import { eyesOf } from './eyes.ts'
import { recallNotes, rememberSight } from './imagine-notes.ts'
import { sightInMemory } from './imagine-sight.ts'
import { loadImagineStore } from './imagine-store.ts'
import { lookWith } from './imagine-models.ts'
import type { ImagineJob } from './job-queue.ts'
import { jobBodyProblem, type JobBody } from './job-start.ts'
import { customFieldsOf, type WorkflowInventory } from './imagine-chat.ts'
import { MAX_JOB_COUNT } from './job-request.ts'
import { loadCustomWorkflow } from './custom-workflows.ts'
import type { RunnableGraph } from './imagine-chat.ts'
import { droppedGateWords, planRunTweaks, readGraph, readingLines } from './graph-reading.ts'
import {
  attemptFingerprint, attemptRefusal, moreOf, moreWord, readEditSpec, runKey, specRefusal, type RunAttempt,
} from './edit-spec.ts'
import { verifyRun, type Verdict } from './edit-verify.ts'

/** What one tool call produced: the result the model reads, and the runs to wait for. */
export interface AgentToolOutcome {
  /** A small JSON object; a failure is `{ ok: false, error }`. */
  readonly result: Readonly<Record<string, unknown>>
  /** The runs this call queued, in order. */
  readonly jobs: readonly ImagineJob[]
  /** A file the host made without a job (the masked removal). */
  readonly files: readonly MediaFileRef[]
}

/** Everything the tools read off the turn. */
export interface AgentToolDeps {
  /** The host, for the vision client. */
  readonly ctx: ImagineHost
  /** The media directory. */
  readonly outputDir: string
  /** The board project the turn belongs to, when the page sent one. */
  readonly projectId?: string
  /** The model the composer shows: the route a look uses. */
  readonly model?: ModelRoute
  /** The interface's language, for the sight instruction. */
  readonly language?: string
  /** The user's line: a closed choice they named is recovered when the model drops it. */
  readonly asked: string
  /** The last line they wrote before this one, for a "riprova" that repeats it. */
  readonly previous?: string
  /** Stops a look when the chat closes. */
  readonly signal?: AbortSignal
  /** Whether «Remove object» is mounted (the request says so). */
  readonly eraseTool: boolean
  /** The studio's own address, for the plugin route the eraser lives behind. */
  readonly selfURL?: string
  /** Starts one run: the route's `startFromBody`, or a fake in the tests. */
  readonly start: (body: JobBody) => Promise<readonly ImagineJob[]>
  /** One run with its live progress. */
  readonly jobView: (job: ImagineJob) => ImagineJobView
  /** The jobs still in memory. */
  readonly listJobs: () => readonly ImagineJob[]
  /** One job by id, when it is still in memory. */
  readonly getJob: (id: string) => ImagineJob | undefined
  /** Puts a host-made file into the project. */
  readonly adoptFiles: (names: readonly string[]) => Promise<void>
  /** The files the page offered the turn (staged and recent). */
  readonly known: readonly MediaFileRef[]
  /** The configured workflows and the personal cards this studio holds. */
  readonly inventory?: WorkflowInventory
  /** The voices this deployment installed, for a voice change. */
  readonly voices?: readonly string[]
  /** Stops a run, after the user confirmed the offer to cancel it. */
  readonly cancelJob: (id: string) => Promise<boolean>
  /** How many more runs the turn may queue. */
  readonly canQueue: () => number
  /** What this turn already tried, when the loop keeps a board (the code guard needs it). */
  readonly attempts?: () => readonly RunAttempt[]
  /** Files one attempt, so a spent budget and a repeated run are seen. */
  readonly remember?: (attempt: RunAttempt) => void
  /** Gives an attempt its outcome once the run settled, with the check's reason. */
  readonly markAttempt?: (key: string, fingerprint: string, state: RunAttempt['state'], why?: string) => void
  /** The last accepted attempt of one picture, for a "più X". */
  readonly lastKept?: (key: string) => RunAttempt | undefined
  /** The files earlier attempts of one request made, for the repeat check. */
  readonly attemptFiles?: (key: string) => readonly string[]
  /** Remembers that a file came from an attempt. */
  readonly keepAttemptFile?: (key: string, file: string) => void
  /** Files a check's verdict, so the turn's report is built on it. */
  readonly keepVerdict?: (verdict: Verdict) => void
  /** The verdicts this turn's checks produced. */
  readonly verdicts?: () => readonly Verdict[]
  /** Tells the page a step happened. */
  readonly say: (event: ImagineChatEvent) => void
}

/** The name the model uses, the schema it sees, and the call it runs. */
export interface AgentTool {
  readonly schema: AgentToolSchema
  run(args: Readonly<Record<string, unknown>>, deps: AgentToolDeps): Promise<AgentToolOutcome>
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

/** One tool result with nothing queued. */
function done(result: Readonly<Record<string, unknown>>): AgentToolOutcome {
  return { result, jobs: [], files: [] }
}

/** A refusal the model can read and correct. */
function refused(error: string): AgentToolOutcome {
  return { result: { ok: false, error }, jobs: [], files: [] }
}

/**
 * A prompt that was translated instead of copied, when it clearly was.
 *
 * The instruction says the prompt is the user's words and not to translate
 * them; a model still wrote "Make the light darker." for "come prima ma più
 * scuro" (2026-11-19). A prompt the user themselves wrote in the other
 * language is left alone: only a language that appears nowhere in their line
 * is refused, so the model can write it again in their words.
 * @param prompt - the prompt the model wrote.
 * @param asked - the user's line.
 * @returns the refusal, or undefined when the prompt may run.
 */
function translatedPrompt(prompt: string, asked: string): string | undefined {
  const user = languageOfPrompt(asked)
  const drawn = languageOfPrompt(prompt)
  if (user === 'unknown' || drawn === 'unknown' || user === drawn) return undefined
  if (asked.toLowerCase().includes(prompt.toLowerCase())) return undefined
  const userName = user === 'it' ? 'Italian' : 'English'
  const drawnName = drawn === 'it' ? 'Italian' : 'English'
  return `the prompt is in ${drawnName} but the user wrote in ${userName}: copy their words into the prompt, do not translate it`
}

/**
 * The names a line carries: two capitalised words in a row, which is how a
 * person, a place or a thing the studio has to draw is named.
 *
 * The prompt is written by the model, and it is allowed to drop the words that
 * are orders rather than things to see — but a name is the subject, not a
 * choice. Measured on the production chat (2026-11-20): the user wrote a full
 * name ("Marta Rossi", the neutral example these tests use), the model wrote
 * only its first word in the prompt, and the graph's own switch, which looks
 * for the full name in the text, never fired: the pictures came out with a
 * generic face. Nothing here reads a graph; it only compares the line with the
 * prompt.
 * @param asked - the user's line.
 * @returns the names, longest first, without duplicates.
 */
export function subjectNames(asked: string): readonly string[] {
  const found = new Set<string>()
  // A capitalised word at the start of the line is the verb ("Genera"), so a
  // name is only taken after another word, not from the first token.
  const re = /\b\p{Lu}[\p{L}'’-]+\s+\p{Lu}[\p{L}'’-]+\b/gu
  for (const match of asked.matchAll(re)) {
    const name = match[0].replace(/\s+/g, ' ').trim()
    // "Genera Delle" is not a name: the first word of a sentence is a verb in
    // every language this studio speaks, and the pair has to be real words.
    if (/^(genera|crea|fai|fammi|voglio|vorrei|make|create|give|draw)\b/i.test(name)) continue
    if (name.length > 60) continue
    found.add(name)
  }
  return [...found].sort((a, b) => b.length - a.length)
}

/**
 * Why a prompt lost part of a name the user wrote, or undefined when it kept
 * every one.
 *
 * A name is copied in full: "Marta" for "Marta Rossi" is not the same
 * subject, and a graph that switches something on from the text cannot see it.
 * The refusal names the whole name, so the model writes it again as it was.
 * @param asked - the user's line.
 * @param prompt - the prompt the model wrote.
 * @returns the refusal, or undefined when every name is in the prompt.
 */
export function lostNameRefusal(asked: string, prompt: string): string | undefined {
  const drawn = prompt.toLowerCase()
  for (const name of subjectNames(asked)) {
    if (drawn.includes(name.toLowerCase())) continue
    // A name whose words are all absent is a prompt about something else: the
    // subject was dropped, and the same sentence applies.
    return `the user's line names "${name}": keep that name in the prompt, word for word — do not shorten it, translate it or turn it into a description`
  }
  return undefined
}

/**
 * Why a call cannot queue what it asked for, said with the numbers.
 *
 * The sentence this replaces ("this turn has already queued all the runs it
 * may") was shown with nothing queued at all, because the budget was the
 * setting's six and the call asked for eight: "already" was false and the
 * user had no way to tell. Nothing already queued is ever lost here.
 * @param remaining - how many runs this turn can still queue.
 * @param wanted - how many this call asked for, when it asked for more than one.
 * @returns the refusal the model reads.
 */
function queueRefusal(remaining: number, wanted = 1): string {
  if (remaining <= 0) {
    return 'this turn has no room for another run: it has queued its whole budget, and those runs are untouched. Ask again for any work beyond it.'
  }
  return `this turn can still queue ${String(remaining)} run${remaining === 1 ? '' : 's'}, not ${String(wanted)}: queue ${String(remaining)} now and ask again for the rest. The runs already queued are untouched.`
}

/** The gallery image a tool names, or a refusal. */
async function galleryImage(deps: AgentToolDeps, name: string): Promise<GalleryItem | string> {
  const safe = safeBasename(name)
  if (safe === undefined || kindOf(safe) !== 'image') return `"${name}" is not a picture in the gallery`
  // A name the folder does not hold is a refusal the model can correct, not
  // an ENOENT thrown at the turn (measured: a reference named but not staged).
  const item = await galleryItemOf(deps.outputDir, safe).catch(() => undefined)
  return item ?? `"${name}" is not in the gallery`
}

/** The inventory key of the graph `generate_image` runs. */
const GENERATE_KEY = 'generate'

/**
 * The graph one tool would run: the configured generation graph, or a personal
 * card by its id. Read fresh for a card, so a card uploaded again is read as it
 * now is.
 * @param deps - the turn.
 * @param which - `generate`, another configured key, or a card id.
 * @returns the graph and its pins, or undefined when there is no such graph.
 */
async function graphFor(deps: Pick<AgentToolDeps, 'inventory'>, which: string): Promise<RunnableGraph | undefined> {
  const configured = deps.inventory?.graphOf?.(which)
  if (configured !== undefined) return configured
  if (!(deps.inventory?.cards ?? []).some(card => card.id === which)) return undefined
  const loaded = await loadCustomWorkflow(which).catch(() => undefined)
  if (loaded === undefined) return undefined
  return {
    graph: loaded.graph,
    ...loaded.promptNodeId === undefined ? {} : { promptNodeId: loaded.promptNodeId },
    ...loaded.seedNodeId === undefined ? {} : { seedNodeId: loaded.seedNodeId },
  }
}

/**
 * Check a prompt and the run's tweaks against the graph that will run them.
 *
 * Two faults this catches before a run is queued: a word that switches a
 * branch on (a LoRA behind `StringContains`) that the user wrote and the
 * prompt lost, and a tweak the graph or the node refuses.
 * @param deps - the turn.
 * @param which - the graph's key or card id.
 * @param prompt - the prompt about to run.
 * @param tweaks - the model's `tweaks`.
 * @returns the values to write on the run's clone, or the refusal.
 */
async function checkedAgainstGraph(
  deps: AgentToolDeps,
  which: string,
  prompt: string,
  tweaks: unknown,
): Promise<{ readonly fields: Readonly<Record<string, string | number | boolean>> } | { readonly error: string }> {
  const runnable = await graphFor(deps, which)
  if (runnable === undefined) {
    return tweaks === undefined ? { fields: {} } : { error: 'this graph cannot be read, so it takes no tweaks: run it without them' }
  }
  const reading = readGraph(runnable.graph, runnable.promptNodeId)
  const dropped = droppedGateWords(reading, prompt, deps.asked)
  if (dropped.length > 0) {
    return {
      error: `the graph switches a branch on only when the prompt contains ${dropped.map(word => `"${word}"`).join(', ')}, the user wrote it, and your prompt lost it: write the prompt again keeping that word exactly as the user wrote it`,
    }
  }
  if (tweaks === undefined) return { fields: {} }
  const facts = deps.inventory?.graphOf?.(which) === undefined ? undefined : await deps.inventory?.facts(which, deps.signal).catch(() => undefined)
  const planned = planRunTweaks(runnable.graph, tweaks, [
    ...runnable.promptNodeId === undefined ? [] : [runnable.promptNodeId],
    ...runnable.seedNodeId === undefined ? [] : [`${runnable.seedNodeId}.seed`, `${runnable.seedNodeId}.noise_seed`],
  ], facts)
  if (planned.errors.length > 0) return { error: `tweaks refused: ${planned.errors.join('; ')}` }
  return { fields: planned.fields }
}

/**
 * What the instruction says about each graph the agent can run: the generation
 * graph and every personal card, one block each. The agent no longer meets a
 * switched LoRA only after a run came out wrong.
 * @param deps - the turn's inventory.
 * @returns one block per readable graph.
 */
export async function graphNotes(deps: Pick<AgentToolDeps, 'inventory'>): Promise<readonly string[]> {
  const notes: string[] = []
  const targets = [
    { which: GENERATE_KEY, label: 'generate_image' },
    ...(deps.inventory?.cards ?? []).map(card => ({ which: card.id, label: `card ${card.id} (${card.title})` })),
  ]
  for (const target of targets) {
    const runnable = await graphFor(deps, target.which)
    if (runnable === undefined) continue
    const lines = readingLines(readGraph(runnable.graph, runnable.promptNodeId))
    notes.push(`- ${target.label}: ${lines.join('; ')}`)
  }
  return notes
}

/** The `tweaks` argument, the same on every tool that runs a graph. */
const TWEAKS_SCHEMA = {
  type: 'object',
  description: 'A change for THIS run only, keyed "<node>.<field>": a sampler value the graph lists (steps, cfg, denoise). Never a LoRA (its weight or its file: "do not touch the LoRA"), never a gate, never the prompt or the seed. Omit when the line asked for nothing the arguments do not already cover.',
  additionalProperties: true,
} as const

/**
 * The spec every run carries: what it changes, what it keeps, how far it goes.
 *
 * Written before the call, it is what the code checks the arguments against and
 * what the verification is asked about. `change` is the user's own words for
 * the change only; `preserve` is the closed list of things that must not move.
 */
const SPEC_SCHEMA = {
  type: 'object',
  description: 'What this run changes and what it must leave alone, written BEFORE the call. change: only the change the user asked for. preserve: what must stay exactly as it is. intensity: "one step" when the line says "più X".',
  properties: {
    change: { type: 'string', description: 'Only the change the user asked for, in their words.' },
    preserve: {
      type: 'array',
      items: { type: 'string', enum: ['format', 'framing', 'text', 'subjects', 'style'] },
      description: 'What must stay: the frame shape, the framing and pose, the written text word for word, the subjects, the medium.',
    },
    intensity: { type: 'string', description: '"one step" when the line says "più X": one step, never a jump. Omit otherwise.' },
  },
  required: ['change'],
  additionalProperties: false,
} as const

/** The denoise a call sets for itself, when it sets one. */
function denoiseOf(tweaks: unknown): number | undefined {
  if (typeof tweaks !== 'object' || tweaks === null) return undefined
  for (const [key, value] of Object.entries(tweaks)) {
    if (key.endsWith('.denoise') && typeof value === 'number') return value
  }
  return undefined
}

/** The fingerprint of one run: the values that decide what it makes. */
function fingerprintOf(parts: Readonly<Record<string, unknown>>): string {
  return attemptFingerprint(Object.fromEntries(Object.entries(parts).filter(([, value]) => value !== undefined)))
}

/**
 * The checks a run goes through before anything is queued: its spec against
 * its own arguments, and the attempts this request already spent.
 * @param deps - the turn.
 * @param args - the tool's arguments.
 * @param context - what the call does, for the spec check.
 * @param key - the request key the attempts are filed under.
 * @param parts - the values that decide what the run makes.
 * @returns the refusal, or the spec and the fingerprint to file afterwards.
 */
function runChecks(
  deps: AgentToolDeps,
  args: Readonly<Record<string, unknown>>,
  context: { readonly prompt: string; readonly changesShape: boolean; readonly edit: boolean },
  key: string,
  parts: Readonly<Record<string, unknown>>,
): { readonly spec: import('./edit-spec.ts').EditSpec; readonly fingerprint: string } | { readonly error: string } {
  const spec = readEditSpec(args['spec'], deps.asked)
  const denoise = denoiseOf(args['tweaks'])
  const contradiction = specRefusal(spec, {
    asked: deps.asked,
    prompt: context.prompt,
    changesShape: context.changesShape,
    edit: context.edit,
    ...denoise === undefined ? {} : { denoise },
  })
  if (contradiction !== undefined) return { error: contradiction }
  const fingerprint = fingerprintOf(parts)
  const spent = attemptRefusal(deps.attempts?.() ?? [], key, fingerprint)
  if (spent !== undefined) return { error: spent }
  deps.remember?.({ key, fingerprint, state: 'ran', prompt: context.prompt, spec })
  return { spec, fingerprint }
}

/**
 * Files what a queued attempt came to, and the files it made.
 *
 * A run that answered `error` is filed as failed, so the same parameters are
 * not sent again: the next call has to change something that matters.
 * @param deps - the turn.
 * @param attempt - the spec and fingerprint of this run.
 * @param key - the request key the attempt is filed under.
 * @param jobs - the runs the call queued.
 */
function rememberRun(
  deps: AgentToolDeps,
  attempt: { readonly fingerprint: string },
  key: string,
  jobs: readonly ImagineJob[],
): void {
  deps.markAttempt?.(key, attempt.fingerprint, jobs.some(job => job.status === 'error') ? 'failed' : 'ran')
  for (const job of jobs) for (const file of job.files ?? []) deps.keepAttemptFile?.(key, file.name)
}

/**
 * Why a check refused a result, in one short line, for the attempt log.
 * @param verdict - what the check found.
 * @returns the reason, as the next call's refusal will show it.
 */
function verdictWhy(verdict: Verdict): string {
  const lost = Object.entries(verdict.preserved_ok).filter(([, ok]) => ok === false).map(([key]) => key)
  if (verdict.identical_to_source) return 'the result was the original again'
  if (verdict.repeated !== undefined) return `it repeated ${verdict.repeated}`
  if (!verdict.requested_change_done) return 'the change asked for is not there'
  if (lost.length > 0) return `lost: ${lost.join(', ')}`
  if (verdict.unrequested_changes.length > 0) return `changed unasked: ${verdict.unrequested_changes.join('; ')}`
  return 'the check did not accept it'
}

/** The longest prompt a tool takes: longer than any line a person writes. */
const MAX_PROMPT = 4_000

/**
 * The batch ceiling the job route itself accepts, not a smaller one.
 *
 * The tool stopped at eight while the route took ten (2026-11-20): "fai 10
 * foto" was refused by the tool although a single call could have carried all
 * ten.
 */
const MAX_COUNT = MAX_JOB_COUNT

/**
 * The shape the studio draws when neither the line nor the arguments name one.
 *
 * The composer opens on the vertical frame and a run that sends no size comes
 * back 9:16 (measured 2026-11-19); naming a resolution without a shape has to
 * keep that shape, not silently drop the size as the tool used to.
 */
const DEFAULT_IMAGE_SHAPE: ImagineAspect = '9:16'

/** How many files `project_files` returns when the model names no limit. */
const FILES_DEFAULT = 40

/** The most `project_files` will ever return: a digest, not a catalogue. */
const FILES_MAX = 80

/**
 * The tools, in the order the instruction lists them.
 *
 * A tool's `name` is the studio's word for the action, English like the rest
 * of the code. `prompt` is the user's own description: the executor trims it
 * and does nothing else to it.
 */
export const AGENT_TOOLS: readonly AgentTool[] = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'generate_image',
        description: 'Queue a new picture. The prompt is the user\'s own description, copied as they wrote it: do not add style words they did not write.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'What to draw, in the user\'s words.' },
            aspect: { type: 'string', enum: [...IMAGINE_ASPECTS], description: 'Frame shape; omit for the studio default.' },
            resolution: { type: 'string', enum: [...IMAGE_RESOLUTIONS], description: 'Short side; the studio\'s default shape (9:16) when no aspect is named.' },
            count: { type: 'integer', minimum: 1, maximum: MAX_COUNT, description: 'How many variants.' },
            reference: { type: 'string', description: 'A gallery picture whose style the user asked to take, when the studio\'s generate graph accepts one; the others\' look goes in the prompt.' },
            spec: SPEC_SCHEMA,
            tweaks: TWEAKS_SCHEMA,
          },
          required: ['prompt', 'spec'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const prompt = str(args['prompt'])
      if (prompt === undefined) return refused('prompt is required and cannot be empty')
      if (prompt.length > MAX_PROMPT) return refused(`prompt is longer than ${String(MAX_PROMPT)} characters`)
      const translated = translatedPrompt(prompt, deps.asked)
      if (translated !== undefined) return refused(translated)
      const lost = lostNameRefusal(deps.asked, prompt)
      if (lost !== undefined) return refused(lost)
      /*
       * A closed choice the user named (a ratio, a resolution) is recovered
       * from their line when the model leaves the argument out: measured on
       * Strata, it kept the description and dropped "3:2" and "480p" from the
       * call while saying them in the reply. Filling a choice the user made is
       * not rewriting their prompt — that stays exactly as they wrote it.
       */
      const named = choicesInLine(deps.asked)
      const aspect = str(args['aspect']) ?? named.aspect
      if (aspect !== undefined && !(IMAGINE_ASPECTS as readonly string[]).includes(aspect)) {
        return refused(`aspect must be one of ${IMAGINE_ASPECTS.join(', ')}`)
      }
      const resolution = str(args['resolution']) ?? named.resolution
      if (resolution !== undefined && !(IMAGE_RESOLUTIONS as readonly string[]).includes(resolution)) {
        return refused(`resolution must be one of ${IMAGE_RESOLUTIONS.join(', ')}`)
      }
      // A count the user named ("tre foto") is recovered when the model drops
      // it, as the ratio and the resolution already were (F1 fix, 2026-11-18).
      const count = countOf(args, deps)
      if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
        return refused(`count must be an integer from 1 to ${String(MAX_COUNT)}`)
      }
      if (deps.canQueue() < count) return refused(queueRefusal(deps.canQueue(), count))
      const shape: ImagineAspect | undefined = aspect === undefined
        ? (resolution === undefined ? undefined : DEFAULT_IMAGE_SHAPE)
        : aspect as ImagineAspect
      const size = shape === undefined ? undefined : sizeFor(shape, (resolution ?? '1080p') as ImagineResolution)
      deps.say({ kind: 'step', step: 'tool', name: 'generate_image', detail: prompt, count })
      const styleRef = str(args['reference'])
      if (styleRef !== undefined) {
        const other = await galleryImage(deps, styleRef)
        if (typeof other === 'string') return refused(other)
      }
      const checked = await checkedAgainstGraph(deps, GENERATE_KEY, prompt, args['tweaks'])
      if ('error' in checked) return refused(checked.error)
      const tweaked = Object.keys(checked.fields).length > 0
      const attempt = runChecks(deps, args, { prompt, changesShape: false, edit: false }, runKey('generate', styleRef), {
        prompt, aspect, resolution, count, reference: styleRef, tweaks: checked.fields,
      })
      if ('error' in attempt) {
        deps.say({ kind: 'step', step: 'tool', name: 'generate_image', detail: prompt, count })
        return refused(attempt.error)
      }
      const jobs = await deps.start({
        action: 'generate',
        prompt,
        ...tweaked ? { customFields: checked.fields } : {},
        ...size === undefined ? {} : { size },
        ...aspect === undefined ? {} : { aspectRatio: aspect, canvasAsked: true },
        ...count > 1 ? { count } : {},
        ...styleRef === undefined ? {} : { reference: styleRef },
        ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
        ...deps.model === undefined ? {} : { model: deps.model },
      })
      for (const job of jobs) deps.say({ kind: 'step', step: 'queued', jobId: job.id, detail: job.action })
      rememberRun(deps, attempt, runKey('generate', styleRef), jobs)
      return {
        result: {
          ok: true,
          queued: jobs.map(job => job.id),
          count: jobs.length,
          state: 'queued',
          spec: attempt.spec,
          attemptKey: runKey('generate', styleRef),
          ...size === undefined ? {} : { size },
          ...aspect === undefined ? {} : { aspect },
          ...aspect === undefined && resolution !== undefined ? { resolution } : {},
          ...styleRef === undefined ? {} : { reference: styleRef },
          ...tweaked ? { tweaks: checked.fields } : {},
        },
        jobs,
        files: [],
      }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'edit_image',
        description: 'Change an existing picture. One change per call. The prompt is the user\'s words; name the thing to change in `target` when they did ("the red handbag"), or pass `region` for a marked zone. The rest of the photo is kept by the studio.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The one change, in the user\'s words.' },
            source: { type: 'string', description: 'The picture to edit, by gallery name.' },
            spec: SPEC_SCHEMA,
            target: { type: 'string', description: 'The thing in the photo the change is about, in the photo\'s own words.' },
            region: {
              type: 'object',
              description: 'A rectangle in fractions of the photo, when the user marked one.',
              properties: {
                x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
              },
              required: ['x', 'y', 'w', 'h'],
              additionalProperties: false,
            },
            reference: { type: 'string', description: 'A second picture to take something from (a garment, a style).' },
            aspect: { type: 'string', enum: [...IMAGINE_ASPECTS], description: 'A new frame shape the user asked for ("falla 9:16"); omit to keep the photo\'s own shape. A new shape redraws the whole photo, so it cannot go with `target` or `region`.' },
            resolution: { type: 'string', enum: [...IMAGE_RESOLUTIONS], description: 'Short side; with `aspect` it sets the new frame, alone it resizes the photo in its own shape.' },
            count: { type: 'integer', minimum: 1, maximum: MAX_COUNT, description: 'How many variants of the edit, when the user asked for more than one.' },
          },
          required: ['prompt', 'source', 'spec'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      let prompt = str(args['prompt'])
      if (prompt === undefined) return refused('prompt is required and cannot be empty')
      if (prompt.length > MAX_PROMPT) return refused(`prompt is longer than ${String(MAX_PROMPT)} characters`)
      /*
       * A model that translated the line has done the one thing the rule
       * forbids. The line itself is the prompt the rule asks for, so it is
       * used instead of failing the request (measured: an Italian edit was
       * sent as "Change the colour of the mug…" and the model then stopped to
       * ask whether to try again).
       */
      const translated = translatedPrompt(prompt, deps.asked)
      if (translated !== undefined) {
        const line = deps.asked.trim()
        if (line.length === 0) return refused(translated)
        prompt = line
        deps.say({ kind: 'step', step: 'tool', name: 'edit_image', detail: 'prompt-from-line' })
      }
      const source = str(args['source'])
      if (source === undefined) return refused('source is required: the picture to edit, by gallery name')
      const item = await galleryImage(deps, source)
      if (typeof item === 'string') return refused(item)
      const target = str(args['target'])
      let region = regionOf(args['region'])
      let grounded = false
      // A new frame shape redraws the whole photo, so no zone is looked for.
      const shapeAsked = str(args['aspect']) ?? choicesInLine(deps.asked).aspect
      if (region === undefined && target !== undefined && shapeAsked === undefined) {
        const sight = (await recallNotes([item.name])).get(item.name)?.sight ?? sightInMemory(item.name)
        const box = await groundTarget(deps.ctx, deps.outputDir, item.name, {
          target,
          ...sight === undefined ? {} : { description: sight },
        }, deps.model, deps.signal)
        if (box === undefined) {
          return refused(`could not find "${target}" in ${item.name}: name it in the photo's own words, or pass a region`)
        }
        region = box
        grounded = true
        deps.say({ kind: 'step', step: 'grounding', detail: target })
      }
      const reference = str(args['reference'])
      if (reference !== undefined) {
        const other = await galleryImage(deps, reference)
        if (typeof other === 'string') return refused(other)
      }
      /*
       * A new frame shape: the agent had no way to ask for one (2026-11-19, a
       * "falla 9:16" edit came back 3:4 twice while the reply said it was
       * done). As in generate_image, a ratio the user named is recovered from
       * the line when the model leaves it out. A new shape redraws the whole
       * frame, so it wins over a zone.
       */
      const named = choicesInLine(deps.asked)
      const aspect = str(args['aspect']) ?? named.aspect
      if (aspect !== undefined && !(IMAGINE_ASPECTS as readonly string[]).includes(aspect)) {
        return refused(`aspect must be one of ${IMAGINE_ASPECTS.join(', ')}`)
      }
      const resolution = str(args['resolution']) ?? named.resolution
      if (resolution !== undefined && !(IMAGE_RESOLUTIONS as readonly string[]).includes(resolution)) {
        return refused(`resolution must be one of ${IMAGE_RESOLUTIONS.join(', ')}`)
      }
      const count = countOf(args, deps)
      if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
        return refused(`count must be an integer from 1 to ${String(MAX_COUNT)}`)
      }
      const reshaped = aspect !== undefined
      if (reshaped) {
        region = undefined
        grounded = false
      }
      // A resolution alone keeps the photo's own shape: the edit graph reads
      // the pixels it is given, so a size without the shape the user did not
      // ask to change has to be the source's.
      const sourceShape = item.width === undefined || item.height === undefined
        ? undefined
        : ratioName(item.width, item.height) as ImagineAspect
      const shape: ImagineAspect | undefined = aspect === undefined
        ? (resolution === undefined ? undefined : sourceShape)
        : aspect as ImagineAspect
      const size = shape === undefined ? undefined : sizeFor(shape, (resolution ?? '1080p') as ImagineResolution)
      if (deps.canQueue() < count) return refused(queueRefusal(deps.canQueue(), count))
      const editKey = runKey('remix', item.name)
      const attempt = runChecks(deps, args, { prompt, changesShape: aspect !== undefined, edit: true }, editKey, {
        prompt, source: item.name, aspect, resolution, count, target, region, reference,
      })
      if ('error' in attempt) return refused(attempt.error)
      deps.say({ kind: 'step', step: 'tool', name: 'edit_image', detail: prompt, ...count > 1 ? { count } : {} })
      const jobs = await deps.start({
        action: 'remix',
        prompt,
        source: item.name,
        ...size === undefined ? {} : { size },
        ...aspect === undefined ? {} : { aspectRatio: aspect, canvasAsked: true },
        ...count > 1 ? { count } : {},
        ...region === undefined ? {} : { region },
        // The name the box was grounded on lets the run cut the object's own
        // outline instead of regenerating the rectangle's background.
        ...grounded && target !== undefined ? { target } : {},
        ...reference === undefined ? {} : { reference },
        ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
        ...deps.model === undefined ? {} : { model: deps.model },
      })
      for (const job of jobs) deps.say({ kind: 'step', step: 'queued', jobId: job.id, detail: job.action })
      rememberRun(deps, attempt, editKey, jobs)
      return {
        result: {
          ok: true,
          queued: jobs.map(job => job.id),
          count: jobs.length,
          state: 'queued',
          spec: attempt.spec,
          attemptKey: editKey,
          source: item.name,
          ...aspect === undefined ? {} : { aspect },
          ...size === undefined ? {} : { size },
          ...reshaped && target !== undefined ? { note: 'a new frame shape redraws the whole photo: the target was not used as a zone' } : {},
        },
        jobs,
        files: [],
      }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'erase',
        description: 'Take something out of a picture and fill the place from what is around it (the masked removal). Use this for a logo, a watermark, a mark printed on the photo — not for a redraw. Needs the eraser plugin.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'The picture, by gallery name.' },
            target: { type: 'string', description: 'What has to disappear, in the photo\'s own words.' },
            region: {
              type: 'object',
              description: 'A rectangle in fractions of the photo, when one is marked.',
              properties: {
                x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
              },
              required: ['x', 'y', 'w', 'h'],
              additionalProperties: false,
            },
          },
          required: ['source'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      if (!deps.eraseTool) return refused('the eraser plugin is not mounted on this studio: use edit_image instead')
      if (deps.selfURL === undefined) return refused('the eraser is not reachable from the server')
      const source = str(args['source'])
      if (source === undefined) return refused('source is required: the picture, by gallery name')
      const item = await galleryImage(deps, source)
      if (typeof item === 'string') return refused(item)
      const target = str(args['target'])
      let region = regionOf(args['region'])
      if (region === undefined && target !== undefined) {
        const sight = (await recallNotes([item.name])).get(item.name)?.sight ?? sightInMemory(item.name)
        const box = await groundTarget(deps.ctx, deps.outputDir, item.name, {
          target,
          ...sight === undefined ? {} : { description: sight },
        }, deps.model, deps.signal)
        if (box === undefined) {
          return refused(`could not find "${target}" in ${item.name}: name it in the photo's own words, or pass a region`)
        }
        region = box
        deps.say({ kind: 'step', step: 'grounding', detail: target })
      }
      if (region === undefined) return refused('the thing to remove is missing: name a target or pass a region')
      const width = item.width
      const height = item.height
      if (width === undefined || height === undefined || width <= 0 || height <= 0) {
        return refused(`${item.name} has no measured size: the eraser needs the photo's pixels`)
      }
      const box = grownRegion(region)
      const feather = Math.max(2, Math.round(Math.min(width, height) * ERASE_FEATHER))
      const mask = featherMask(rectangleMask(width, height, box), feather)
      deps.say({ kind: 'step', step: 'tool', name: 'erase', detail: target ?? 'the marked zone' })
      let answer: Response
      try {
        answer = await fetch(`${deps.selfURL.replace(/\/+$/, '')}/plugin/iopaint/erase`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: item.name, mask: maskDataUrl(mask) }),
          signal: deps.signal,
        })
      } catch (error: unknown) {
        return refused(`the eraser did not answer: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!answer.ok) {
        const detail = await answer.text().catch(() => '')
        if (answer.status === 404) return refused('the eraser plugin is not mounted on this studio: use edit_image instead')
        return refused(`the eraser answered ${String(answer.status)}: ${detail.slice(0, 300)}`)
      }
      const made = await answer.json().catch(() => undefined) as GalleryItem | undefined
      if (made === undefined || typeof made.name !== 'string') return refused('the eraser answered no file')
      await deps.adoptFiles([made.name]).catch(() => undefined)
      return {
        result: { ok: true, file: made.name, kind: 'image', note: 'the rest of the photo is the source\'s own pixels' },
        jobs: [],
        files: [{ name: made.name, kind: 'image' }],
      }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'look',
        description: 'Look at one file for one specific question, through the studio\'s vision pass. Pass `question` naming the thing to check, not "describe everything": the pass answers only that. The result also carries the file\'s measured width, height, ratio and duration, which are the truth about its shape.',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'The gallery file to look at.' },
            frame: { type: 'number', description: 'For a clip: the second to take a frame at. Default 0.' },
            question: { type: 'string', description: 'The one thing to check, in the user\'s terms; omit to check the line itself.' },
          },
          required: ['file'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const file = str(args['file'])
      if (file === undefined) return refused('file is required')
      const safe = safeBasename(file)
      if (safe === undefined) return refused(`"${file}" is not a gallery file name`)
      const kind = kindOf(safe)
      if (kind !== 'image' && kind !== 'video') return refused(`"${safe}" is not a picture or a clip`)
      const item = await galleryItemOf(deps.outputDir, safe)
      if (item === undefined) return refused(`"${safe}" is not in the gallery`)
      const eyes = eyesOf(deps.ctx, deps.model)
      if (eyes === undefined) return refused('no vision model is configured on this studio')
      const asked = str(args['question'])
      /*
       * A look is a check, not an essay. The old instruction asked for "what
       * is visible" even when the turn only needed to know whether the change
       * landed, and the vision pass answered with details nobody asked for
       * ("dark bands", a saucer, coffee in the cup) that reached the reply as
       * facts (2026-11-19). A question, when the model wrote one, is answered
       * alone; without one the look is anchored on the user's own line.
       */
      const language = languageName(deps.language)
      const subject = deps.asked.trim().length === 0 ? 'the file' : `"${deps.asked.trim()}"`
      /*
       * The file's own header is the only authority on its size and length:
       * the vision pass estimated 1600x1200 on a 1080x720 picture (2026-11-19)
       * while the tool result carried the real numbers, so the exact facts go
       * into the instruction and the pass is told not to estimate them.
       */
      const measured: string[] = []
      if (item.width !== undefined && item.height !== undefined && item.width > 0 && item.height > 0) {
        measured.push(`${String(item.width)}x${String(item.height)} pixels`, `ratio ${ratioName(item.width, item.height)}`)
      }
      if (item.duration !== undefined && item.duration > 0) measured.push(`${item.duration.toFixed(1)} seconds long`)
      const facts = measured.length === 0
        ? 'The file carries no measured size in its header: do not estimate one.'
        : `Measured facts from the file's header, exact: ${measured.join(', ')}. Use these numbers whenever size, shape or length is asked, and never state a different one.`
      const sobriety = 'Describe only what is clearly visible: the subject, the setting, the main colours and how the frame is composed. Do not estimate dimensions, counts, colours, written text, marks or objects that are not plainly visible; when something is not clear, say it is not clearly visible. Read written text only when it is legible, and quote it exactly.'
      const instruction = asked === undefined
        ? `${facts}\nThe user asked: ${subject}. Look at this file only to answer that, in ${language}, in two or three sentences. ${sobriety}`
        : `${facts}\nAnswer only this question about the file, in ${language}, in one or two sentences: "${asked}". ${sobriety}`
      let target = join(deps.outputDir, safe)
      let scratch: string | undefined
      try {
        let at = 0
        if (kind === 'video') {
          at = Number(args['frame'] ?? 0)
          if (!Number.isFinite(at) || at < 0) return refused('frame must be a non-negative number of seconds')
          scratch = await mkdtemp(join(tmpdir(), 'imagine-agent-look-'))
          target = await frameAt(join(deps.outputDir, safe), join(scratch, 'frame.jpg'), { at, maxSide: 1024, quality: 3, timeoutMs: 20_000 })
        }
        const seen = await lookWith(eyes.vision, target, instruction, eyes.route, {
          ...deps.signal === undefined ? {} : { signal: deps.signal },
        })
        if (seen === undefined) return refused(`the vision model did not answer for ${safe}`)
        const text = seen.text.replace(/\s+/g, ' ').trim()
        // A pointed answer is not a description: filing it as the file's sight
        // would make the next turn believe the photo is whatever was asked.
        if (asked === undefined) await rememberSight(safe, text).catch(() => undefined)
        deps.say({ kind: 'step', step: 'looked', detail: safe })
        return done({
          ok: true,
          file: safe,
          kind,
          ...item.width === undefined ? {} : { width: item.width },
          ...item.height === undefined ? {} : { height: item.height },
          ...item.width === undefined || item.height === undefined ? {} : { ratio: ratioName(item.width, item.height) },
          ...item.duration === undefined ? {} : { duration: item.duration },
          ...kind === 'video' ? { frame: at } : {},
          seen: text,
        })
      } finally {
        if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'more_of',
        description: 'One step further on a picture a check already accepted. "Più X" is the last accepted state plus one small named step — never a new idea, never a jump. Answers the prompt and the spec to pass to `edit_image`.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'The picture to push further, by gallery name. Omit for a generation.' },
            axis: { type: 'string', description: 'The word after "più" ("caldo", "scuro", "saturo"…). Copied from the user\'s line when omitted.' },
          },
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const source = str(args['source'])
      if (source !== undefined) {
        const item = await galleryKind(deps, source, ['image'])
        if (typeof item === 'string') return refused(item)
      }
      const key = runKey(source === undefined ? 'generate' : 'remix', source)
      const axis = str(args['axis'])
      const next = moreOf(deps.lastKept?.(key), axis === undefined ? moreWord(deps.asked) : axis.toLowerCase())
      if ('error' in next) return refused(next.error)
      deps.say({ kind: 'step', step: 'tool', name: 'more_of', detail: source ?? key })
      return done({
        ok: true,
        key,
        prompt: next.prompt,
        spec: next.spec,
        note: 'run this with `edit_image` (a generation goes through `generate_image`), then check the result before asking for another step',
      })
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'check_result',
        description: 'Check a result against the picture it came from and the spec it carried, and get the verdict the reply must be built from: the change done or not, each kept item, the written text read literally, what changed unasked, whether it is the original again or a repeat. Call it after every edit, before writing the reply.',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'The result, by gallery name.' },
            source: { type: 'string', description: 'The picture it was made from, for an edit: the check puts the two side by side.' },
            spec: SPEC_SCHEMA,
            previous: {
              type: 'array',
              items: { type: 'string' },
              description: 'Earlier results of the same request, to catch a repeat.',
            },
          },
          required: ['file', 'spec'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const file = str(args['file'])
      if (file === undefined) return refused('file is required: the result, by gallery name')
      const item = await galleryKind(deps, file, ['image'])
      if (typeof item === 'string') return refused(item)
      const source = str(args['source'])
      if (source !== undefined) {
        const from = await galleryKind(deps, source, ['image'])
        if (typeof from === 'string') return refused(from)
      }
      const spec = readEditSpec(args['spec'], deps.asked)
      const checkKey = runKey(source === undefined ? 'generate' : 'remix', source)
      /*
       * A repeat is looked for without the model having to remember: the files
       * this request already made are the ones the new result is compared with.
       */
      const recalled = deps.attemptFiles?.(checkKey) ?? []
      const previous = [...new Set([
        ...(Array.isArray(args['previous']) ? args['previous'].filter((name): name is string => typeof name === 'string' && name !== '') : []),
        ...recalled,
      ])].filter(name => name !== item.name)
      deps.say({ kind: 'step', step: 'tool', name: 'check_result', detail: item.name })
      const checked = await verifyRun({
        ctx: deps.ctx,
        outputDir: deps.outputDir,
        ...deps.model === undefined ? {} : { model: deps.model },
        ...deps.language === undefined ? {} : { language: deps.language },
        ...deps.signal === undefined ? {} : { signal: deps.signal },
        say: deps.say,
      }, {
        file: item.name,
        ...source === undefined ? {} : { source },
        spec,
        ...previous.length === 0 ? {} : { previous },
      })
      if ('error' in checked) return refused(checked.error)
      deps.keepVerdict?.(checked.verdict)
      /*
       * The verdict decides how the attempt of that request is filed: a
       * failed check is what makes the same parameters refuse to run again.
       */
      const last = (deps.attempts?.() ?? []).filter(attempt => attempt.key === checkKey).at(-1)
      const why = verdictWhy(checked.verdict)
      if (last !== undefined) {
        deps.markAttempt?.(checkKey, last.fingerprint, checked.verdict.state === 'completed' ? 'kept' : 'failed', why)
      }
      return done({
        ok: true,
        file: item.name,
        ...checked.verdict,
        note: checked.verdict.changed_region === undefined
          ? 'the reply opens with the word for this state and carries what this verdict found: never a denial of a loss it names, never "done" when it is partial or failed'
          : `the difference from the original is in one place (x ${String(checked.verdict.changed_region.x)}, y ${String(checked.verdict.changed_region.y)}, w ${String(checked.verdict.changed_region.w)}, h ${String(checked.verdict.changed_region.h)}, in fractions of the frame): fix that spot with \`edit_image\` and that \`region\`, not with a whole repaint. The reply opens with the word for this state and carries what this verdict found`,
      })
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'project_files',
        description: 'The files of this project, newest first, with how each was made and what a vision pass saw in it. Use this instead of remembering names.',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['image', 'video', 'audio'], description: 'Only this kind, when set.' },
            limit: { type: 'integer', minimum: 1, maximum: FILES_MAX, description: 'How many files, newest first.' },
          },
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const kind = str(args['kind'])
      if (kind !== undefined && kind !== 'image' && kind !== 'video' && kind !== 'audio') {
        return refused('kind must be image, video or audio')
      }
      const limit = args['limit'] === undefined ? FILES_DEFAULT : Number(args['limit'])
      if (!Number.isInteger(limit) || limit < 1 || limit > FILES_MAX) {
        return refused(`limit must be an integer from 1 to ${String(FILES_MAX)}`)
      }
      const names = await projectFileNames(deps)
      const gallery = new Map((await listGallery(deps.outputDir)).map(item => [item.name, item]))
      const shown = [...names].reverse().filter((name) => {
        const item = gallery.get(name)
        return item !== undefined && (kind === undefined || item.kind === kind)
      }).slice(0, limit)
      const notes = await recallNotes(shown)
      const files = shown.map((name) => {
        const item = gallery.get(name) as GalleryItem
        const note = notes.get(name)
        const seen = note?.sight ?? sightInMemory(name)
        return {
          name,
          kind: item.kind,
          ...item.width === undefined ? {} : { width: item.width },
          ...item.height === undefined ? {} : { height: item.height },
          ...note?.origin === undefined ? {} : { made: note.origin },
          ...seen === undefined ? {} : { seen },
        }
      })
      return done({ ok: true, files })
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'job_status',
        description: 'The real state of one run by id, or of the runs still going: queued, running (with progress), waiting for the user to approve an install on ComfyUI (`setup-needed`, with `missing`), done, error (with the reason) or cancelled. Use it to answer "is it done?" without guessing.',
        parameters: {
          type: 'object',
          properties: {
            job: { type: 'string', description: 'The run id; omit for the runs still going.' },
          },
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const id = str(args['job'])
      if (id !== undefined) {
        const job = deps.getJob(id)
        if (job === undefined) return refused(`no run with id ${id} is in memory (runs live half an hour after they finish)`)
        return done({ ok: true, job: viewOf(deps, job) })
      }
      const live = deps.listJobs().filter(job => job.status === 'queued' || job.status === 'running')
      const waiting = live.filter(job => job.notice === 'setup-needed')
      return done({
        ok: true,
        jobs: live.map(job => viewOf(deps, job)),
        note: live.length === 0
          ? 'no run is in progress'
          : waiting.length === 0
          ? undefined
          : `${String(waiting.length)} run waits for the user to approve an install on ComfyUI: it is not rendering until then`,
      })
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'make_video',
        description: 'Animate a picture into a clip (image to video). One continuous take: up to 6 s it is one clip, longer is rendered as chained scenes. Use `last_frame` to land the clip on a second picture (one clip, 6 s at most). A clip longer than the confirmation limit stops for the user\'s yes before it is queued.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'The starting picture, by gallery name.' },
            prompt: { type: 'string', description: 'What happens (motion, camera), in the user\'s words. Empty lets the studio write it from the picture.' },
            seconds: { type: 'integer', minimum: 2, maximum: 60, description: 'Length in seconds; the user\'s length when they named one.' },
            aspect: { type: 'string', enum: [...IMAGINE_ASPECTS], description: 'Frame shape; omit for the studio default.' },
            resolution: { type: 'string', enum: [...VIDEO_RESOLUTIONS], description: 'Clip ladder: 480p or 720p.' },
            speed: { type: 'string', enum: ['fast', 'slow'], description: 'slow = the high-quality graph (several times longer).' },
            last_frame: { type: 'string', description: 'A gallery picture the clip should end on.' },
          },
          required: ['source'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const source = str(args['source'])
      if (source === undefined) return refused('source is required: the picture to animate, by gallery name')
      const item = await galleryKind(deps, source, ['image'])
      if (typeof item === 'string') return refused(item)
      const last = str(args['last_frame'])
      if (last !== undefined) {
        const frame = await galleryKind(deps, last, ['image'])
        if (typeof frame === 'string') return refused(frame)
      }
      const prompt = str(args['prompt']) ?? ''
      if (prompt.length > MAX_PROMPT) return refused(`prompt is longer than ${String(MAX_PROMPT)} characters`)
      // The studio refuses a clip with no description: it has nothing to
      // animate. Say it here, so the model asks the user instead of guessing.
      if (prompt.length === 0) {
        return refused('a clip needs what happens in it: ask the user for the motion, or copy their description')
      }
      const numbers = numbersInLine(deps.asked)
      const seconds = args['seconds'] === undefined ? numbers.seconds ?? 5 : Math.round(Number(args['seconds']))
      if (!Number.isFinite(seconds) || seconds < 2 || seconds > 60) return refused('seconds must be from 2 to 60')
      if (last !== undefined && seconds > 6) return refused('a clip that lands on a last frame is one clip: seconds must be 6 or less')
      const named = choicesInLine(deps.asked)
      const aspect = str(args['aspect']) ?? named.aspect
      if (aspect !== undefined && !(IMAGINE_ASPECTS as readonly string[]).includes(aspect)) {
        return refused(`aspect must be one of ${IMAGINE_ASPECTS.join(', ')}`)
      }
      const resolution = str(args['resolution']) ?? named.resolution ?? '720p'
      if (!(VIDEO_RESOLUTIONS as readonly string[]).includes(resolution)) {
        return refused(`a clip renders at ${VIDEO_RESOLUTIONS.join(' or ')}; ${resolution} is not on its ladder`)
      }
      const speed = str(args['speed']) ?? 'fast'
      if (speed !== 'fast' && speed !== 'slow') return refused('speed must be fast or slow')
      if (deps.canQueue() < 1) return refused(queueRefusal(deps.canQueue()))
      deps.say({ kind: 'step', step: 'tool', name: 'make_video', detail: prompt })
      const jobs = await deps.start({
        action: 'video',
        prompt,
        source: item.name,
        seconds,
        ...aspect === undefined ? {} : { aspectRatio: videoAspectLabel(aspect as ImagineAspect), canvasAsked: true },
        megapixels: megapixelsFor(resolution as ImagineResolution),
        speed,
        quality: speed === 'slow' ? 'high' : 'standard',
        ...last === undefined ? {} : { lastSource: last },
        ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
        ...deps.model === undefined ? {} : { model: deps.model },
      })
      for (const job of jobs) deps.say({ kind: 'step', step: 'queued', jobId: job.id, detail: job.action })
      return {
        result: { ok: true, queued: jobs.map(job => job.id), state: 'queued', seconds, source: item.name },
        jobs,
        files: [],
      }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'extend_video',
        description: 'Continue a clip that already exists (the result is the whole clip with its continuation). Past 6 s it is rendered as chained scenes. A length longer than the confirmation limit stops for the user\'s yes.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'The clip to continue, by gallery name.' },
            prompt: { type: 'string', description: 'What happens next, in the user\'s words. Empty continues the clip\'s own motion.' },
            seconds: { type: 'integer', minimum: 2, maximum: 60, description: 'How much to add, in seconds.' },
          },
          required: ['source'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const source = str(args['source'])
      if (source === undefined) return refused('source is required: the clip to continue, by gallery name')
      const item = await galleryKind(deps, source, ['video'])
      if (typeof item === 'string') return refused(item)
      const prompt = str(args['prompt']) ?? ''
      if (prompt.length > MAX_PROMPT) return refused(`prompt is longer than ${String(MAX_PROMPT)} characters`)
      const seconds = args['seconds'] === undefined ? numbersInLine(deps.asked).seconds ?? 5 : Math.round(Number(args['seconds']))
      if (!Number.isFinite(seconds) || seconds < 2 || seconds > 60) return refused('seconds must be from 2 to 60')
      if (deps.canQueue() < 1) return refused(queueRefusal(deps.canQueue()))
      deps.say({ kind: 'step', step: 'tool', name: 'extend_video', detail: prompt })
      const jobs = await deps.start({
        action: 'extend',
        prompt,
        source: item.name,
        seconds,
        ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
        ...deps.model === undefined ? {} : { model: deps.model },
      })
      for (const job of jobs) deps.say({ kind: 'step', step: 'queued', jobId: job.id, detail: job.action })
      return { result: { ok: true, queued: jobs.map(job => job.id), state: 'queued', seconds }, jobs, files: [] }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'loop_video',
        description: 'An animated background from a picture: the clip begins and ends on the same frame, so it repeats with no seam. Not for a scene with a beginning and an end (that is make_video). A length longer than the confirmation limit stops for the user\'s yes.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'The picture, by gallery name.' },
            prompt: { type: 'string', description: 'What moves in the background, in the user\'s words.' },
            seconds: { type: 'integer', minimum: 5, maximum: 60, description: 'Length in seconds; the studio joins its segments past 10.' },
          },
          required: ['source'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const source = str(args['source'])
      if (source === undefined) return refused('source is required: the picture, by gallery name')
      const item = await galleryKind(deps, source, ['image'])
      if (typeof item === 'string') return refused(item)
      const prompt = str(args['prompt']) ?? ''
      if (prompt.length === 0) {
        return refused('a loop needs what moves in it: ask the user what should move, or copy their description')
      }
      if (prompt.length > MAX_PROMPT) return refused(`prompt is longer than ${String(MAX_PROMPT)} characters`)
      const seconds = args['seconds'] === undefined ? numbersInLine(deps.asked).seconds ?? 5 : Math.round(Number(args['seconds']))
      if (!Number.isFinite(seconds) || seconds < 5 || seconds > 60) return refused('a loop runs from 5 to 60 seconds')
      if (deps.canQueue() < 1) return refused(queueRefusal(deps.canQueue()))
      deps.say({ kind: 'step', step: 'tool', name: 'loop_video', detail: prompt })
      const jobs = await deps.start({
        action: 'loop',
        prompt,
        source: item.name,
        seconds,
        ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
        ...deps.model === undefined ? {} : { model: deps.model },
      })
      for (const job of jobs) deps.say({ kind: 'step', step: 'queued', jobId: job.id, detail: job.action })
      return { result: { ok: true, queued: jobs.map(job => job.id), state: 'queued', seconds }, jobs, files: [] }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'make_story',
        description: 'A VIDEO cut into shots, 20-300 s: over a song, or one shot per photo (a montage). It always renders pictures, so use it only when the user asks for a video, a clip, a montage or a story; when the line asks for music, a song or a track alone, that is make_music (audio only), never this tool. It always stops for the user\'s yes before it is queued. Use `sources` for several photos (one shot each) and `source` for one photo grown scene by scene; `song` is an existing audio track, `lyrics` the text the shots sing.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'What the video is about, in the user\'s words.' },
            source: { type: 'string', description: 'One picture or clip the story grows from, by gallery name.' },
            sources: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12, description: 'One gallery photo per shot (a montage).' },
            seconds: { type: 'integer', minimum: 20, maximum: 300, description: 'Total length; a song decides it when one is given.' },
            song: { type: 'string', description: 'An audio track already in the gallery, by name.' },
            lyrics: { type: 'string', description: 'The text the shots themselves sing, when the user gave one.' },
            hard_cuts: { type: 'boolean', description: 'True when the shots are joined on hard cuts instead of one continuous take.' },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const prompt = str(args['prompt']) ?? deps.asked
      if (prompt.length === 0) return refused('prompt is required: what the story is about')
      if (prompt.length > MAX_PROMPT) return refused(`prompt is longer than ${String(MAX_PROMPT)} characters`)
      /*
       * F2 routed "30 seconds of music" to a story: the tool's own words
       * mention the song, and the model took it. A story always renders
       * pictures, so a line that asks for a track and nothing to watch is
       * pointed at the audio-only tool instead of queuing a video nobody
       * asked for.
       */
      if (asksOnlyForMusic(deps.asked)) {
        return refused('this line asks for music alone, not a video: make_story renders a video in shots. Use make_music for a music track (audio only); if the user wants pictures over that track, call make_story with the photos and the song.')
      }
      let source: string | undefined
      const one = str(args['source'])
      if (one !== undefined) {
        const item = await galleryKind(deps, one, ['image', 'video'])
        if (typeof item === 'string') return refused(item)
        source = item.name
      }
      const photos: string[] = []
      if (Array.isArray(args['sources'])) {
        for (const name of args['sources']) {
          if (typeof name !== 'string') continue
          const photo = await galleryKind(deps, name, ['image'])
          if (typeof photo === 'string') return refused(photo)
          photos.push(photo.name)
        }
      }
      if (source === undefined && photos.length === 0) {
        return refused('a story needs a picture (`source`) or a list of photos (`sources`)')
      }
      let song: string | undefined
      const track = str(args['song'])
      if (track !== undefined) {
        const item = await galleryKind(deps, track, ['audio'])
        if (typeof item === 'string') return refused(item)
        song = item.name
      }
      const seconds = args['seconds'] === undefined ? numbersInLine(deps.asked).seconds : Math.round(Number(args['seconds']))
      if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 20 || seconds > 300)) {
        return refused('a story runs from 20 to 300 seconds')
      }
      if (deps.canQueue() < 1) return refused(queueRefusal(deps.canQueue()))
      deps.say({ kind: 'step', step: 'tool', name: 'make_story', detail: prompt })
      const jobs = await deps.start({
        action: 'story',
        prompt,
        ...source === undefined ? {} : { source },
        ...photos.length === 0 ? {} : { sources: photos },
        ...seconds === undefined ? {} : { seconds },
        ...song === undefined ? {} : { song },
        ...str(args['lyrics']) === undefined ? {} : { lyrics: str(args['lyrics']) },
        ...args['hard_cuts'] === true ? { hardCuts: true } : {},
        ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
        ...deps.model === undefined ? {} : { model: deps.model },
      })
      for (const job of jobs) deps.say({ kind: 'step', step: 'queued', jobId: job.id, detail: job.action })
      return {
        result: {
          ok: true, queued: jobs.map(job => job.id), state: 'queued', shots: jobs.length,
          ...seconds === undefined ? {} : { seconds },
          ...song === undefined ? {} : { song },
        },
        jobs,
        files: [],
      }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'make_music',
        description: 'A separate music track: audio only, with no pictures. Use it whenever the user asks for music, a song, a track, a beat or a jingle of its own, even when they name a length; make_story is for a video that happens to have a song. It always stops for the user\'s yes. `prompt` is the style, `lyrics` the words to sing; `seconds` only when the user named a length (30-300), otherwise the studio decides from the words.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The style or genre, in the user\'s words.' },
            lyrics: { type: 'string', description: 'The words to sing, copied from the user\'s message.' },
            seconds: { type: 'integer', minimum: 30, maximum: 300, description: 'The length the user asked for, when they named one.' },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const prompt = str(args['prompt'])
      if (prompt === undefined) return refused('prompt is required: the style of the track')
      if (prompt.length > MAX_PROMPT) return refused(`prompt is longer than ${String(MAX_PROMPT)} characters`)
      const seconds = args['seconds'] === undefined ? numbersInLine(deps.asked).seconds : Math.round(Number(args['seconds']))
      if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 30 || seconds > 300)) {
        return refused('music runs from 30 to 300 seconds, or leaves the length to the studio')
      }
      const lyrics = str(args['lyrics'])
      if (lyrics !== undefined && lyrics.length > 8_000) return refused('lyrics are longer than 8000 characters')
      if (deps.canQueue() < 1) return refused(queueRefusal(deps.canQueue()))
      deps.say({ kind: 'step', step: 'tool', name: 'make_music', detail: prompt })
      const jobs = await deps.start({
        action: 'music',
        prompt,
        ...lyrics === undefined ? {} : { lyrics },
        ...seconds === undefined ? {} : { seconds },
        ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
        ...deps.model === undefined ? {} : { model: deps.model },
      })
      for (const job of jobs) deps.say({ kind: 'step', step: 'queued', jobId: job.id, detail: job.action })
      return { result: { ok: true, queued: jobs.map(job => job.id), state: 'queued', ...seconds === undefined ? {} : { seconds } }, jobs, files: [] }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'add_audio',
        description: 'Lay an audio track that already exists over a clip that already exists, without re-rendering the picture: the clip decides the length. The host does it in seconds, so no run is queued and no confirmation is asked.',
        parameters: {
          type: 'object',
          properties: {
            video: { type: 'string', description: 'The clip that keeps its picture, by gallery name.' },
            track: { type: 'string', description: 'The audio track to lay over it, by gallery name.' },
          },
          required: ['video', 'track'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      if (deps.selfURL === undefined) return refused('the audio join is not reachable from the server')
      const video = str(args['video'])
      const track = str(args['track'])
      if (video === undefined || track === undefined) return refused('video and track are required')
      const clip = await galleryKind(deps, video, ['video'])
      if (typeof clip === 'string') return refused(clip)
      const audio = await galleryKind(deps, track, ['audio'])
      if (typeof audio === 'string') return refused(audio)
      deps.say({ kind: 'step', step: 'tool', name: 'add_audio', detail: `${audio.name} → ${clip.name}` })
      let answer: Response
      try {
        answer = await fetch(`${deps.selfURL.replace(/\/+$/, '')}/api/add-audio`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: clip.name, track: audio.name }),
          signal: deps.signal,
        })
      } catch (error: unknown) {
        return refused(`the audio join did not answer: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!answer.ok) {
        const detail = await answer.text().catch(() => '')
        return refused(`the audio join answered ${String(answer.status)}: ${detail.slice(0, 300)}`)
      }
      const made = await answer.json().catch(() => undefined) as GalleryItem | undefined
      if (made === undefined || typeof made.name !== 'string') return refused('the audio join answered no file')
      await deps.adoptFiles([made.name]).catch(() => undefined)
      return {
        result: { ok: true, file: made.name, kind: 'video', note: 'the picture is the clip\'s own, copied' },
        jobs: [],
        files: [{ name: made.name, kind: kindOf(made.name) ?? 'video' }],
      }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'speak',
        description: 'Read a text aloud and save the audio (text to speech). Not change_voice (that re-sings a track that exists) and not make_music (that sings).',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The text to read, in the language it is written in.' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const text = str(args['text'])
      if (text === undefined) return refused('text is required: the words to read aloud')
      if (text.length > MAX_PROMPT) return refused(`text is longer than ${String(MAX_PROMPT)} characters`)
      if (deps.canQueue() < 1) return refused(queueRefusal(deps.canQueue()))
      deps.say({ kind: 'step', step: 'tool', name: 'speak', detail: text.slice(0, 80) })
      const jobs = await deps.start({
        action: 'speak',
        prompt: text,
        ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
        ...deps.model === undefined ? {} : { model: deps.model },
      })
      for (const job of jobs) deps.say({ kind: 'step', step: 'queued', jobId: job.id, detail: job.action })
      return { result: { ok: true, queued: jobs.map(job => job.id), state: 'queued' }, jobs, files: [] }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'change_voice',
        description: 'Re-sing a track that already exists with another voice, keeping the music. `source` may be an audio file or a clip (the studio takes the clip\'s soundtrack and returns the clip with the new voice). `pitch` is the shift in semitones: a deeper voice is negative.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'The audio track or the clip whose voice changes, by gallery name.' },
            voice: { type: 'string', description: 'Which installed voice to use; omit for the studio\'s default.' },
            pitch: { type: 'integer', minimum: -24, maximum: 24, description: 'Semitones to shift by; negative goes down.' },
          },
          required: ['source'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const source = str(args['source'])
      if (source === undefined) return refused('source is required: the track or clip whose voice changes')
      const item = await galleryKind(deps, source, ['audio', 'video'])
      if (typeof item === 'string') return refused(item)
      const voice = str(args['voice'])
      if (voice !== undefined && deps.voices !== undefined && deps.voices.length > 0 && !deps.voices.includes(voice)) {
        return refused(`voice must be one of the installed voices: ${deps.voices.join(', ')}`)
      }
      const pitch = args['pitch'] === undefined ? undefined : Math.round(Number(args['pitch']))
      if (pitch !== undefined && (!Number.isFinite(pitch) || pitch < -24 || pitch > 24)) {
        return refused('pitch must be an integer from -24 to 24 semitones')
      }
      if (deps.canQueue() < 1) return refused(queueRefusal(deps.canQueue()))
      deps.say({ kind: 'step', step: 'tool', name: 'change_voice', detail: item.name })
      const jobs = await deps.start({
        action: 'voice',
        prompt: '',
        source: item.name,
        ...voice === undefined ? {} : { voice },
        ...pitch === undefined ? {} : { pitch },
        ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
        ...deps.model === undefined ? {} : { model: deps.model },
      })
      for (const job of jobs) deps.say({ kind: 'step', step: 'queued', jobId: job.id, detail: job.action })
      return { result: { ok: true, queued: jobs.map(job => job.id), state: 'queued' }, jobs, files: [] }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'upscale',
        description: 'Raise the resolution of a picture or a clip that already exists. A still goes to 1080, 1440 or 2160 (4K); a clip to 720 or 1080. An upscale to 4K always stops for the user\'s yes.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'The picture or clip, by gallery name.' },
            upscaleTo: { type: 'integer', enum: [720, 1080, 1440, 2160], description: 'The short side to reach; omit to raise to the next step.' },
          },
          required: ['source'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const source = str(args['source'])
      if (source === undefined) return refused('source is required: the picture or clip to raise')
      const item = await galleryKind(deps, source, ['image', 'video'])
      if (typeof item === 'string') return refused(item)
      const ladder: readonly number[] = item.kind === 'video' ? UPSCALE_VIDEO_STEPS : UPSCALE_IMAGE_STEPS
      const asked = args['upscaleTo'] === undefined ? undefined : Math.round(Number(args['upscaleTo']))
      if (asked !== undefined && !ladder.includes(asked)) {
        return refused(`a ${item.kind} goes to ${ladder.join(', ')}; ${String(asked)} is not on its ladder`)
      }
      if (deps.canQueue() < 1) return refused(queueRefusal(deps.canQueue()))
      deps.say({ kind: 'step', step: 'tool', name: 'upscale', detail: item.name })
      const jobs = await deps.start({
        action: 'upscale',
        prompt: '',
        source: item.name,
        ...asked === undefined ? {} : { upscaleTo: asked },
        ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
        ...deps.model === undefined ? {} : { model: deps.model },
      })
      for (const job of jobs) deps.say({ kind: 'step', step: 'queued', jobId: job.id, detail: job.action })
      return { result: { ok: true, queued: jobs.map(job => job.id), state: 'queued' }, jobs, files: [] }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'inspect_workflow',
        description: 'Read what a graph does inside before running it: its LoRAs with their weights, the words in the prompt that switch a LoRA or a branch on, the sampler values, whether it takes a picture in. `workflow` is "generate" (what generate_image runs) or a personal card id. Use it when the user names a LoRA, a person, a style the graph may carry, or asks why a result came out as it did. The keys it lists are the ones `tweaks` takes.',
        parameters: {
          type: 'object',
          properties: {
            workflow: { type: 'string', description: '"generate" or a personal card id, copied exactly.' },
          },
          required: ['workflow'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const which = str(args['workflow']) ?? GENERATE_KEY
      const runnable = await graphFor(deps, which)
      if (runnable === undefined) {
        const cards = (deps.inventory?.cards ?? []).map(card => card.id).join(', ')
        return refused(`no graph "${which}" to read; the graphs are: ${GENERATE_KEY}${cards === '' ? '' : `, ${cards}`}`)
      }
      deps.say({ kind: 'step', step: 'tool', name: 'inspect_workflow', detail: which })
      const reading = readGraph(runnable.graph, runnable.promptNodeId)
      return done({
        ok: true,
        workflow: which,
        reading: readingLines(reading),
        loras: reading.loras.map(lora => ({
          name: lora.name,
          weight: lora.strength,
          node: lora.node,
          editable: false,
          ...lora.gate === undefined ? {} : { needsWord: lora.gate.word, when: lora.gate.when },
        })),
        sampler: reading.sampler,
        takesImage: reading.takesImage,
      })
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'run_card',
        description: 'Run one of this studio\'s personal cards («Your workflows») with its own inputs. The id and the input keys are copied exactly from the personal cards in this instruction; never invent one. It always stops for the user\'s yes.',
        parameters: {
          type: 'object',
          properties: {
            customWorkflowId: { type: 'string', description: 'The card id, copied exactly from the list.' },
            prompt: { type: 'string', description: 'What to draw, in the user\'s words.' },
            customFields: { type: 'object', description: 'The card\'s exposed inputs, keyed "<node>.<field>".', additionalProperties: true },
            customFiles: { type: 'object', description: 'The card\'s file slots: node id → gallery file name.', additionalProperties: { type: 'string' } },
            spec: SPEC_SCHEMA,
            tweaks: TWEAKS_SCHEMA,
            count: { type: 'integer', minimum: 1, maximum: MAX_COUNT, description: 'How many runs of the card, when the user asked for several pictures.' },
          },
          required: ['customWorkflowId', 'spec'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const id = str(args['customWorkflowId'])
      if (id === undefined) return refused('customWorkflowId is required: the card id, copied from the list')
      const cards = deps.inventory?.cards ?? []
      const card = cards.find(entry => entry.id === id)
      if (card === undefined) {
        return refused(`no personal card has id ${id}; the cards are: ${cards.map(entry => `${entry.id} (${entry.title})`).join(', ') || 'none'}`)
      }
      const prompt = str(args['prompt']) ?? ''
      if (prompt.length > MAX_PROMPT) return refused(`prompt is longer than ${String(MAX_PROMPT)} characters`)
      const fields = customFieldsOf(args['customFields'], card)
      const files: Record<string, string> = {}
      if (typeof args['customFiles'] === 'object' && args['customFiles'] !== null) {
        for (const [node, name] of Object.entries(args['customFiles'])) {
          if (typeof name !== 'string' || !/^\d+$/.test(node)) return refused('customFiles must map a node id to a gallery file name')
          const item = await galleryKind(deps, name, ['image', 'video', 'audio'])
          if (typeof item === 'string') return refused(item)
          files[node] = item.name
        }
      }
      /*
       * A name the line carries stays literal: "Marta Rossi" shortened to
       * "Marta" is a different subject, and a graph that switches a LoRA on
       * from the text cannot see it.
       */
      const lost = lostNameRefusal(deps.asked, prompt)
      if (lost !== undefined) return refused(lost)
      const checked = await checkedAgainstGraph(deps, card.id, prompt, args['tweaks'])
      if ('error' in checked) return refused(checked.error)
      // The card's exposed inputs win over a tweak of the same input: they are
      // the controls the user sees.
      const runFields = { ...checked.fields, ...fields }
      /*
       * A card that draws a new picture takes the same batch as the studio's
       * own generate: ten pictures are one call, not ten turns. Before this,
       * `run_card` had no count at all, so a line asking for ten was answered
       * with a series at a time.
       */
      const count = countOf(args, deps)
      if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
        return refused(`count must be an integer from 1 to ${String(MAX_COUNT)}`)
      }
      if (deps.canQueue() < count) return refused(queueRefusal(deps.canQueue(), count))
      const cardKey = runKey('custom', card.id)
      const attempt = runChecks(deps, args, { prompt, changesShape: false, edit: false }, cardKey, {
        prompt, card: card.id, count, fields: runFields, files,
      })
      if ('error' in attempt) return refused(attempt.error)
      deps.say({ kind: 'step', step: 'tool', name: 'run_card', detail: card.title, count })
      const jobs = await deps.start({
        action: 'custom',
        prompt,
        customWorkflowId: card.id,
        ...count > 1 ? { count } : {},
        ...Object.keys(runFields).length === 0 ? {} : { customFields: runFields },
        ...Object.keys(files).length === 0 ? {} : { customFiles: files },
        ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
        ...deps.model === undefined ? {} : { model: deps.model },
      })
      for (const job of jobs) deps.say({ kind: 'step', step: 'queued', jobId: job.id, detail: job.action })
      rememberRun(deps, attempt, cardKey, jobs)
      return { result: { ok: true, queued: jobs.map(job => job.id), count: jobs.length, state: 'queued', card: card.title, spec: attempt.spec, attemptKey: cardKey }, jobs, files: [] }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'run_action',
        description: 'Run any other studio action with the studio\'s own fields, for parity with the composer: objectSwap (objectMode change, remove, background or add; a photo in `reference` replaces the object), swapPerson (a video and the photo of the new person), recreate (a video shot again; `extras.keepAudio`), relight (a photo and a `light` id), compose (a person and a reference photo), bg, redo, resume, scanFrame, regenerate, custom. Use the dedicated tool when one exists. `extras` carries the action\'s own fields exactly as the studio sends them.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: [...IMAGINE_ACTIONS], description: 'The studio action to run.' },
            prompt: { type: 'string', description: 'What to do, in the user\'s words; empty when the action does not take one.' },
            source: { type: 'string', description: 'The main file, by gallery name, when the action starts from one.' },
            reference: { type: 'string', description: 'The second file, by gallery name, when the action takes one.' },
            extras: {
              type: 'object',
              description: 'The action\'s other fields: seconds, size, aspectRatio, megapixels, swapResolution, speed, quality, lyrics, voice, pitch, count, candidates, customWorkflowId, customFields, customFiles, frame, song, light, objectMode, placement, upscaleTo, region, lastSource, sources, keepAudio, lipSync, hardCuts.',
              additionalProperties: true,
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const action = str(args['action'])
      if (action === undefined || !(IMAGINE_ACTIONS as readonly string[]).includes(action)) {
        return refused(`action must be one of ${IMAGINE_ACTIONS.join(', ')}`)
      }
      let prompt = str(args['prompt']) ?? ''
      if (prompt.length > MAX_PROMPT) return refused(`prompt is longer than ${String(MAX_PROMPT)} characters`)
      const translated = translatedPrompt(prompt, deps.asked)
      if (translated !== undefined) {
        const line = deps.asked.trim()
        if (line.length === 0) return refused(translated)
        prompt = line
        deps.say({ kind: 'step', step: 'tool', name: 'run_action', detail: 'prompt-from-line' })
      }
      const source = str(args['source'])
      if (source !== undefined) {
        const item = await galleryKind(deps, source, ['image', 'video', 'audio'])
        if (typeof item === 'string') return refused(item)
      }
      const reference = str(args['reference'])
      if (reference !== undefined) {
        const item = await galleryKind(deps, reference, ['image', 'video', 'audio'])
        if (typeof item === 'string') return refused(item)
      }
      const extras = extrasOf(args['extras'])
      if (typeof extras === 'string') return refused(extras)
      for (const field of ['lastSource', 'frame', 'song'] as const) {
        const name = extras[field]
        if (typeof name !== 'string') continue
        const item = await galleryKind(deps, name, ['image', 'video', 'audio'])
        if (typeof item === 'string') return refused(item)
      }
      if (Array.isArray(extras['sources'])) {
        for (const name of extras['sources']) {
          if (typeof name !== 'string') continue
          const item = await galleryKind(deps, name, ['image'])
          if (typeof item === 'string') return refused(item)
        }
      }
      if (typeof extras['customFiles'] === 'object' && extras['customFiles'] !== null) {
        for (const name of Object.values(extras['customFiles'])) {
          if (typeof name !== 'string') continue
          const item = await galleryKind(deps, name, ['image', 'video', 'audio'])
          if (typeof item === 'string') return refused(item)
        }
      }
      const body: JobBody = {
        action: action as ImagineAction,
        prompt,
        ...source === undefined ? {} : { source },
        ...reference === undefined ? {} : { reference },
        ...extras,
      }
      const invalid = jobBodyProblem(body)
      if (invalid !== undefined) return refused(invalid)
      if (NEEDS_SOURCE.has(action) && source === undefined) {
        return refused(`action ${action} starts from a file: pass it in source`)
      }
      if ((action === 'video' || action === 'loop') && prompt.length === 0) {
        return refused(`action ${action} needs what happens in it: ask the user, or copy their description`)
      }
      if ((action === 'compose' || action === 'swapPerson') && reference === undefined) {
        return refused(`action ${action} takes a second file: pass it in reference`)
      }
      if (action === 'objectSwap' && (body.objectMode ?? 'change') === 'change' && reference === undefined) {
        return refused('objectSwap in change mode needs the photo of the new object in reference')
      }
      if (deps.canQueue() < 1) return refused(queueRefusal(deps.canQueue()))
      deps.say({ kind: 'step', step: 'tool', name: 'run_action', detail: `${action}${prompt.length === 0 ? '' : `: ${prompt}`}` })
      const jobs = await deps.start({
        ...body,
        ...deps.projectId === undefined ? {} : { projectId: deps.projectId },
        ...deps.model === undefined ? {} : { model: deps.model },
      })
      for (const job of jobs) deps.say({ kind: 'step', step: 'queued', jobId: job.id, detail: job.action })
      return {
        result: { ok: true, queued: jobs.map(job => job.id), state: 'queued', action },
        jobs,
        files: [],
      }
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'cancel_job',
        description: 'Propose stopping a run. This NEVER stops anything by itself: the proposal always goes to the user, and only their yes cancels the run. Use it when the user asks to stop a run, or when a run is clearly not what they wanted.',
        parameters: {
          type: 'object',
          properties: {
            job: { type: 'string', description: 'The id of the run to stop.' },
          },
          required: ['job'],
          additionalProperties: false,
        },
      },
    },
    async run(args, deps) {
      const id = str(args['job'])
      if (id === undefined) return refused('job is required: the id of the run to stop')
      const job = deps.getJob(id)
      if (job === undefined) return refused(`no run with id ${id} is in memory (runs live half an hour after they finish)`)
      if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
        return refused(`run ${id} had already ${job.status === 'done' ? 'finished' : job.status}`)
      }
      const stopped = await deps.cancelJob(id)
      if (!stopped) return refused(`run ${id} could not be stopped`)
      return done({ ok: true, cancelled: id })
    },
  },
]

/**
 * The confirmation a tool call needs before it runs, or undefined when it may
 * run at once.
 *
 * The owner's rule (2026-11-18): a clip longer than `confirmSeconds` is
 * confirmed first, and a story, a piece of music, a montage, a personal card
 * and an upscale to 4K always are: their cost is a chain, not one clip. A
 * cancel is only ever a proposal. The function reads the same arguments the
 * tool will read, and never throws on an argument the model got wrong: the
 * tool itself refuses that with a sentence, after the gate.
 * @param name - the tool the model called.
 * @param args - its arguments, unchecked.
 * @param asked - the user's line, for a length or a count they named.
 * @param confirmSeconds - the longest clip that runs without asking.
 * @param deps - the turn, for the personal cards and the run a cancel is about.
 * @returns the offer the page shows, or undefined.
 */
export function confirmationFor(
  name: string,
  args: Readonly<Record<string, unknown>>,
  asked: string,
  confirmSeconds: number,
  deps: Pick<AgentToolDeps, 'inventory' | 'getJob'>,
): Omit<AgentPendingOffer, 'token' | 'expiresAt'> | undefined {
  const named = numbersInLine(asked)
  const secondsOf = (fallback: number): number => args['seconds'] === undefined
    ? named.seconds ?? fallback
    : Math.round(Number(args['seconds']))
  if (name === 'make_video' || name === 'extend_video' || name === 'loop_video') {
    const seconds = secondsOf(5)
    // An argument the tool itself will refuse is not worth a question, and a
    // clip that lands on a last frame is one clip anyway.
    if (!Number.isFinite(seconds) || seconds < 2 || seconds > 60) return undefined
    if (name === 'make_video' && str(args['last_frame']) !== undefined) return undefined
    if ((name === 'make_video' || name === 'loop_video') && str(args['prompt']) === undefined) return undefined
    if (seconds <= confirmSeconds) return undefined
    return {
      kind: 'run',
      tool: name,
      action: name === 'make_video' ? 'video' : name === 'extend_video' ? 'extend' : 'loop',
      summary: message('agent.confirmClip', { seconds: String(seconds) }),
      seconds,
      ...str(args['source']) === undefined ? {} : { source: str(args['source']) as string },
    }
  }
  if (name === 'make_story') {
    // A line that asks for a track and nothing to watch is refused by the
    // tool with the audio-only tool named: there is nothing to confirm first.
    if (asksOnlyForMusic(asked)) return undefined
    const seconds = args['seconds'] === undefined ? named.seconds : Math.round(Number(args['seconds']))
    const known = seconds !== undefined && Number.isFinite(seconds) ? seconds : undefined
    return {
      kind: 'run',
      tool: name,
      action: 'story',
      summary: known === undefined
        ? message('agent.confirmStoryNoLength')
        : message('agent.confirmStory', { seconds: String(known) }),
      ...known === undefined ? {} : { seconds: known },
      ...str(args['source']) === undefined ? {} : { source: str(args['source']) as string },
    }
  }
  if (name === 'make_music') {
    const seconds = args['seconds'] === undefined ? named.seconds : Math.round(Number(args['seconds']))
    const known = seconds !== undefined && Number.isFinite(seconds) ? seconds : undefined
    return {
      kind: 'run',
      tool: name,
      action: 'music',
      summary: known === undefined ? message('agent.confirmMusicNoLength') : message('agent.confirmMusic', { seconds: String(known) }),
      ...known === undefined ? {} : { seconds: known },
    }
  }
  if (name === 'upscale') {
    const to = args['upscaleTo'] === undefined ? undefined : Math.round(Number(args['upscaleTo']))
    const source = str(args['source'])
    // 4K is a still's step: a clip tops at 1080, and the tool refuses 2160.
    if (to !== 2160 || (source !== undefined && kindOf(source) === 'video')) return undefined
    return {
      kind: 'run',
      tool: name,
      action: 'upscale',
      summary: message('agent.confirmUpscale4k'),
      ...str(args['source']) === undefined ? {} : { source: str(args['source']) as string },
    }
  }
  if (name === 'run_card') {
    const id = str(args['customWorkflowId'])
    const card = (deps.inventory?.cards ?? []).find(entry => entry.id === id)
    // An id the card list does not hold is refused by the tool, not asked about.
    if (card === undefined) return undefined
    return {
      kind: 'run',
      tool: name,
      action: 'custom',
      summary: message('agent.confirmCard', { card: card?.title ?? id ?? '?' }),
      ...card === undefined ? {} : { card: card.title },
    }
  }
  if (name === 'run_action') {
    const action = str(args['action'])
    const extras = typeof args['extras'] === 'object' && args['extras'] !== null && !Array.isArray(args['extras'])
      ? args['extras'] as Record<string, unknown>
      : {}
    const length = extras['seconds'] === undefined ? named.seconds : Math.round(Number(extras['seconds']))
    const known = length !== undefined && Number.isFinite(length) ? length : undefined
    const source = str(args['source'])
    if (action === 'story') {
      return {
        kind: 'run', tool: name, action,
        summary: known === undefined
          ? message('agent.confirmStoryNoLength')
          : message('agent.confirmStory', { seconds: String(known) }),
        ...known === undefined ? {} : { seconds: known },
        ...source === undefined ? {} : { source },
      }
    }
    if (action === 'music') {
      return {
        kind: 'run', tool: name, action,
        summary: known === undefined ? message('agent.confirmMusicNoLength') : message('agent.confirmMusic', { seconds: String(known) }),
        ...known === undefined ? {} : { seconds: known },
      }
    }
    if (action === 'custom') {
      const id = typeof extras['customWorkflowId'] === 'string' ? extras['customWorkflowId'] : undefined
      const card = (deps.inventory?.cards ?? []).find(entry => entry.id === id)
      if (card === undefined) return undefined
      return { kind: 'run', tool: name, action, summary: message('agent.confirmCard', { card: card.title }), card: card.title }
    }
    if (action === 'video' || action === 'extend' || action === 'loop') {
      const seconds = known ?? 5
      if (!Number.isFinite(seconds) || seconds < 2 || seconds > 60 || seconds <= confirmSeconds) return undefined
      if (action === 'video' && typeof extras['lastSource'] === 'string') return undefined
      return {
        kind: 'run', tool: name, action,
        summary: message('agent.confirmClip', { seconds: String(seconds) }),
        seconds,
        ...source === undefined ? {} : { source },
      }
    }
    if (action === 'upscale' && Number(extras['upscaleTo']) === 2160) {
      return {
        kind: 'run', tool: name, action,
        summary: message('agent.confirmUpscale4k'),
        ...source === undefined ? {} : { source },
      }
    }
    return undefined
  }
  if (name === 'cancel_job') {
    const id = str(args['job'])
    if (id === undefined) return undefined
    const job = deps.getJob(id)
    // Nothing to stop: the tool refuses with the reason instead of asking.
    if (job === undefined || job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return undefined
    return {
      kind: 'cancel',
      tool: name,
      summary: message('agent.confirmCancel', { job: job === undefined ? id : `${job.action} (${id})` }),
      jobId: id,
    }
  }
  return undefined
}

/** The offer {@link confirmationFor} builds, before the token is minted. */
export interface AgentPendingOffer {
  readonly kind: 'run' | 'cancel'
  readonly tool: string
  readonly action?: string
  readonly summary: string
  readonly seconds?: number
  readonly source?: string
  readonly card?: string
  readonly jobId?: string
}

/**
 * Whether a line asks for a piece of music and nothing to watch.
 *
 * The router in F2 sent "30 secondi di musica" to `make_story`, because a story
 * can carry a song. It can, but it always renders pictures: a line naming only
 * a track (or saying "no video") belongs to `make_music`. Pictures or a video
 * in the line make it a story, and an explicit "only music" / "no video" wins
 * over a stray picture word.
 * @param asked - the user's line.
 * @returns true when the line is about a track alone.
 */
export function asksOnlyForMusic(asked: string): boolean {
  const text = asked.toLowerCase()
  if (!/\b(music\w*|brano|traccia|canzone|song|track|beat|jingle|soundtrack|colonna sonora)\b/.test(text)) return false
  if (/\b(solo|soltanto|only|just)\s+(la\s+)?(musica|music|canzone|song|traccia|track|brano)\b/.test(text)) return true
  if (/\b(nessun|senza)\s+(il\s+)?video\b|\b(no|not|without)\s+(a\s+|any\s+)?video\b|\bnon\s+(un\s+)?video\b/.test(text)) return true
  const video = /\b(video\w*|filmato|film|clip|scena|scene|shots?|montaggio|montage|fotogrammi|frames?|riprese|videoclip|storia|story)\b/
  const pictures = /\b(foto\w*|fotografie|immagin[ei]|pictures?|photos?|images?)\b/
  return !video.test(text) && !pictures.test(text)
}

/**
 * A length or a count the user named in their line, which the model may leave
 * out of the call even when it repeats it in the reply.
 *
 * Only the closed shapes are read: a length with its unit ("16 secondi",
 * "30s", "un minuto") and a count before a picture word ("tre foto", "2
 * immagini"). A ratio ("16:9") is never a length, and a bare number is not a
 * count: guessing there would invent a run nobody asked for.
 * @param asked - the user's line.
 * @returns the seconds and the count it names, when it names them.
 */
export function numbersInLine(asked: string): { seconds?: number; count?: number } {
  const text = asked.toLowerCase()
  const unit = '(?:s\\b|sec\\b|secs\\b|secondo|secondi|second|seconds)'
  let seconds: number | undefined
  const digits = new RegExp(`(\\d{1,3})\\s*${unit}`).exec(text)?.[1]
  if (digits !== undefined) seconds = Number(digits)
  if (seconds === undefined) {
    if (/\bmezzo minuto\b|\bhalf a minute\b/.test(text)) seconds = 30
    else if (/\bun minuto\b|\bone minute\b|\ba minute\b/.test(text)) seconds = 60
    else if (/\bdue minuti\b|\btwo minutes\b/.test(text)) seconds = 120
    else if (/\btre minuti\b|\bthree minutes\b/.test(text)) seconds = 180
  }
  const words: Readonly<Record<string, number>> = {
    un: 1, una: 1, uno: 1, one: 1, a: 1, due: 2, two: 2, tre: 3, three: 3, quattro: 4, four: 4,
    cinque: 5, five: 5, sei: 6, six: 6, sette: 7, seven: 7, otto: 8, eight: 8,
  }
  let count: number | undefined
  const picture = '(?:foto|fotografie|immagin[ei]|variant[ei]|version[ei]|immagine|pictures?|photos?|images?|variants?|versions?)'
  const counted = new RegExp(`(\\d{1,2})\\s+${picture}`).exec(text)?.[1]
  if (counted !== undefined) count = Number(counted)
  if (count === undefined) {
    const spelled = new RegExp(`\\b(${Object.keys(words).join('|')})\\s+${picture}`).exec(text)?.[1]
    if (spelled !== undefined) count = words[spelled]
  }
  return {
    ...seconds === undefined ? {} : { seconds },
    ...count === undefined ? {} : { count },
  }
}

/** The actions that cannot run without a starting file. */
const NEEDS_SOURCE = new Set([
  'remix', 'video', 'loop', 'extend', 'upscale', 'bg', 'voice', 'redo', 'resume', 'scanFrame',
  'recreate', 'regenerate', 'relight', 'compose', 'objectSwap', 'swapPerson',
])

/**
 * The type each `extras` field of `run_action` must have, and the closed list
 * of fields it may carry: a body field the studio does not know, or one with
 * the wrong type, is refused rather than dropped.
 */
const EXTRA_TYPES: Readonly<Record<string, 'string' | 'number' | 'boolean' | 'strings' | 'object'>> = {
  size: 'string', aspectRatio: 'string', swapResolution: 'string', speed: 'string', quality: 'string',
  lyrics: 'string', voice: 'string', song: 'string', light: 'string', objectMode: 'string',
  frame: 'string', lastSource: 'string', mask: 'string', customWorkflowId: 'string',
  seconds: 'number', megapixels: 'number', pitch: 'number', count: 'number', candidates: 'number',
  upscaleTo: 'number', clipSeconds: 'number',
  keepAudio: 'boolean', lipSync: 'boolean', hardCuts: 'boolean', canvasAsked: 'boolean',
  sources: 'strings', placement: 'object', region: 'object', customFields: 'object', customFiles: 'object',
}

/**
 * The `extras` of a `run_action`, checked field by field.
 * @param value - the argument the model sent.
 * @returns the fields, or the sentence saying why one is not usable.
 */
function extrasOf(value: unknown): Readonly<Record<string, unknown>> | string {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'extras must be an object'
  const kept: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    const kind = EXTRA_TYPES[key]
    if (kind === undefined) return `extras.${key} is not a field of a studio request`
    if (kind === 'strings') {
      if (!Array.isArray(raw) || !raw.every(name => typeof name === 'string')) return `extras.${key} must be a list of gallery names`
      kept[key] = raw
      continue
    }
    if (kind === 'object') {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `extras.${key} must be an object`
      kept[key] = raw
      continue
    }
    if (typeof raw !== kind) return `extras.${key} must be a ${kind}`
    kept[key] = raw
  }
  return kept
}

/** Whether a line asks for the previous request again. */
function isRetry(asked: string): boolean {
  return /^(riprova|riprova\b|rifallo|fallo (di nuovo|ancora)|try again|do it again)\b/i.test(asked.trim())
}

/**
 * How many pictures a call should queue.
 *
 * The model's count wins, except on a "riprova" that repeats a line naming a
 * number: the request is still that one, so a smaller count is the model
 * stopping halfway through it (measured: a 10-picture request retried as 8).
 * @param args - the call's arguments.
 * @param deps - the turn.
 * @returns the count to queue.
 */
function countOf(args: Readonly<Record<string, unknown>>, deps: AgentToolDeps): number {
  const asked = numbersInLine(deps.asked).count
  const repeated = isRetry(deps.asked) && deps.previous !== undefined ? numbersInLine(deps.previous).count : undefined
  const named = asked ?? repeated
  const given = args['count'] === undefined ? undefined : Number(args['count'])
  if (named === undefined) return given ?? 1
  // A number the user named is recovered when the model drops it, and a retry
  // never queues less than the request it is repeating.
  if (given === undefined) return named
  return repeated !== undefined && given < repeated && asked === undefined ? repeated : given
}

/** The gallery file of one of the kinds the tool accepts, or a refusal. */
async function galleryKind(
  deps: AgentToolDeps,
  name: string,
  kinds: readonly GalleryItem['kind'][],
): Promise<GalleryItem | string> {
  const safe = safeBasename(name)
  if (safe === undefined || kindOf(safe) === undefined) return `"${name}" is not a file in the gallery`
  const kind = kindOf(safe) as GalleryItem['kind']
  if (!kinds.includes(kind)) return `"${safe}" is ${kind === 'image' ? 'a picture' : `a ${kind}`}; this tool takes ${kinds.join(' or ')}`
  const item = await galleryItemOf(deps.outputDir, safe)
  return item ?? `"${safe}" is not in the gallery`
}


/**
 * The tools the loop offers, as the gateway takes them.
 * @returns the schemas, in catalogue order.
 */
export function agentToolSchemas(): readonly AgentToolSchema[] {
  return AGENT_TOOLS.map(tool => tool.schema)
}

/**
 * Run one tool call, checking its name and reporting a refusal as a result
 * rather than an exception: the model reads the sentence and corrects itself.
 * @param name - the tool the model named.
 * @param args - its arguments, already parsed from the model's JSON.
 * @param deps - the turn's state.
 * @returns the outcome, always (a failure is `{ ok: false, error }`).
 */
export async function runAgentTool(
  name: string,
  args: Readonly<Record<string, unknown>>,
  deps: AgentToolDeps,
): Promise<AgentToolOutcome> {
  const tool = AGENT_TOOLS.find(entry => entry.schema.function.name === name)
  if (tool === undefined) {
    return refused(`there is no tool called "${name}": use one of ${AGENT_TOOLS.map(entry => entry.schema.function.name).join(', ')}`)
  }
  try {
    return await tool.run(args, deps)
  } catch (error: unknown) {
    return refused(error instanceof Error ? error.message : String(error))
  }
}

/**
 * One run as the model reads it: state, where it is, and what it made.
 *
 * A run can be waiting for the user without running: ComfyUI has to install a
 * model or a node pack first (`notice: 'setup-needed'`), and the page shows the
 * install button. The state says so here, with what is missing, instead of the
 * plain `queued` that read as "in progress" in F2.
 * @param deps - the turn's state, for the live progress.
 * @param job - the run.
 * @returns a compact object, no pixels.
 */
function viewOf(deps: AgentToolDeps, job: ImagineJob): Readonly<Record<string, unknown>> {
  const view = deps.jobView(job)
  const progress = view.progress
  const waitingForSetup = job.notice === 'setup-needed' && job.setup !== undefined
  return {
    id: job.id,
    action: job.action,
    state: waitingForSetup ? 'setup-needed' : job.status,
    ...waitingForSetup ? {} : { status: job.status },
    prompt: job.prompt.length > 300 ? `${job.prompt.slice(0, 299)}…` : job.prompt,
    ...job.source === undefined ? {} : { source: job.source },
    ...progress?.percent === undefined ? {} : { percent: progress.percent },
    ...progress?.nodeClass === undefined ? {} : { stage: progress.nodeClass },
    ...progress?.etaSeconds === undefined ? {} : { etaSeconds: progress.etaSeconds },
    ...job.notice === undefined ? {} : { notice: job.notice },
    ...job.setup === undefined ? {} : { missing: missingOf(job.setup), downloadBytes: job.setup.bytes },
    ...job.setupProgress === undefined ? {} : { install: job.setupProgress },
    ...waitingForSetup ? { waitingFor: 'the user\'s yes to install on ComfyUI: it is not rendering' } : {},
    ...job.error === undefined ? {} : { error: job.error },
    ...job.files === undefined || job.files.length === 0 ? {} : { files: job.files.map(file => file.name) },
  }
}

/** What a setup plan is missing, one sentence per entry, for the model to repeat. */
function missingOf(plan: NonNullable<ImagineJob['setup']>): string[] {
  const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`
  return [
    ...plan.packs.map(pack => pack.name),
    ...plan.models.map(model => `${model.name} (${gb(model.size)})`),
  ]
}

/**
 * The names of the project's files, oldest first: what it lists, what its runs
 * in memory made, and what the host adopted into it.
 * @param deps - the turn's state.
 * @returns the names, deduplicated, without the page's own offer as a fallback.
 */
async function projectFileNames(deps: AgentToolDeps): Promise<string[]> {
  const names = new Set<string>()
  if (deps.projectId !== undefined) {
    const store = await loadImagineStore().catch(() => undefined)
    const project = store?.projects.find(entry => entry.id === deps.projectId)
    if (project !== undefined) {
      for (const name of project.itemNames) names.add(name)
      for (const id of project.jobIds) {
        const job = deps.getJob(id)
        for (const file of job?.files ?? []) names.add(file.name)
      }
      const adopted = store?.adopted[deps.projectId] ?? {}
      for (const key of Object.keys(adopted)) {
        if (kindOf(key) !== undefined) names.add(key)
      }
    }
  }
  if (names.size === 0) for (const file of deps.known) names.add(file.name)
  return [...names]
}

/**
 * The choices a line names in the studio's own spelling: a ratio or a
 * resolution, which the model may leave out of the call even when it repeats
 * them in its reply.
 * @param asked - the user's line.
 * @returns the aspect and the resolution it names, when it names them.
 */
export function choicesInLine(asked: string): { aspect?: ImagineAspect; resolution?: ImagineResolution } {
  const resolutionWord = /\b(480p|720p|1080p|1440p)\b/i.exec(asked)?.[1]?.toLowerCase()
  const ratio = /\b(\d{1,2}:\d{1,2})\b/.exec(asked)?.[1]
  const words: readonly (readonly [RegExp, ImagineAspect])[] = [
    [/\bquadrat[oaie]\b/i, '1:1'],
    [/\bvertical[ei]?\b|\bportrait\b/i, '9:16'],
    [/\borizzontal[ei]?\b|\blandscape\b|\bwidescreen\b/i, '16:9'],
  ]
  const named: ImagineAspect | undefined = ratio !== undefined && (IMAGINE_ASPECTS as readonly string[]).includes(ratio)
    ? ratio as ImagineAspect
    : words.find(([pattern]) => pattern.test(asked))?.[1]
  return {
    ...named === undefined ? {} : { aspect: named },
    ...resolutionWord === undefined || !(IMAGE_RESOLUTIONS as readonly string[]).includes(resolutionWord)
      ? {}
      : { resolution: resolutionWord as ImagineResolution },
  }
}

/** The nearest common ratio, as the studio spells it. */
function ratioName(width: number, height: number): string {
  const shapes = ['1:1', '9:16', '16:9', '3:4', '4:3', '2:3', '3:2', '4:5', '5:4', '21:9']
  const value = width / height
  let best = shapes[0] ?? '1:1'
  for (const shape of shapes) {
    const [w, h] = shape.split(':').map(Number)
    const wanted = (w ?? 1) / (h ?? 1)
    const [bw, bh] = best.split(':').map(Number)
    if (Math.abs(Math.log(value / wanted)) < Math.abs(Math.log(value / ((bw ?? 1) / (bh ?? 1))))) best = shape
  }
  return best
}

/**
 * A region out of the model's arguments, checked by the shared rule when the
 * removal or the edit reaches the job.
 * @param value - the `region` argument.
 * @returns the region, or undefined when the model sent none.
 */
function regionOf(value: unknown): ImagineRegion | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { x, y, w, h } = value as Record<string, unknown>
  if (![x, y, w, h].every(part => typeof part === 'number' && Number.isFinite(part))) return undefined
  return { x: x as number, y: y as number, w: w as number, h: h as number }
}
