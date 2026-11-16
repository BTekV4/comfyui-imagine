/**
 * The runs of a template, as the server executes them.
 *
 * A template's form becomes plans ({@link expandTemplate}): ordinary jobs, ffmpeg
 * compositions, and the chains hanging off them (`then`: a picture cut out
 * after it was drawn, a clip animated after it was framed). This module runs
 * them, and it does it through exactly the same path the job route uses
 * ({@link startFromBody}): the same argument checks, the same queue, the same
 * adoption into the board project, so a run started from a template is
 * indistinguishable from one started by hand — same live tile, same cancel,
 * same gallery note.
 *
 * Three decisions worth knowing:
 *
 * - Every planned body is checked **before** anything is queued: the job
 *   route's own checks ({@link jobBodyProblem}) for each job, chain steps
 *   included, and the existence and kind of every gallery file a run reads. A
 *   form whose third run would be refused queues none of them, so the user's
 *   retry does not duplicate the first two. What can still fail half way (the
 *   queue refusing a graph, ffmpeg refusing a file) ends the loop, and the
 *   answer carries what had started plus the sentence of what stopped it.
 * - A chain waits in the background, never on the HTTP answer: the first runs
 *   are queued and the request is answered at once, while the steps of a
 *   `then` are queued one after another as their predecessor settles. A step
 *   waits for as long as its job sits in the queue (a busy GPU can hold it for
 *   hours); only a job that has been *running* past {@link CHAIN_RUNNING_TIMEOUT_MS}
 *   is given up on. Every chain that stops early says so in the log, with
 *   the template and the step.
 * - The chains live **in memory only**. A restart of the studio loses every
 *   step that had not been queued yet — and with it the whole queue, which is
 *   in memory too — so a template half of which was still waiting comes back
 *   as the files that had already landed on the board, nothing more.
 * @module tool-comfy/template-jobs
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  expandTemplate, type PlanCompose, type PlanJob, type PlanJobOrCompose, type Template, type TemplateValues,
} from '../../../shared/imagine-templates.ts'
import { message } from '../../src/messages.ts'
import { kindOf, safeBasename } from './gallery.ts'
import { getImagineJob, whenJobsSettle, type ImagineJob } from './imagine-jobs.ts'
import { adoptJobsInto } from './imagine-store.ts'
import { jobBodyProblem, startFromBody, type JobBody, type JobStartContext } from './job-start.ts'
import { composeTemplate } from './template-compose.ts'

/**
 * How long one chained step may stay *running* before its chain gives up on
 * it. Counted from the moment the step is seen running, never from when it
 * was queued: the time in the queue is the other runs' time, not this one's.
 * An H3 clip is the slowest step a template makes, and it is well inside this.
 */
export const CHAIN_RUNNING_TIMEOUT_MS = 3 * 60 * 60_000

/** How often a waiting chain looks at its step again, to measure the running time. */
const CHAIN_WAKE_MS = 60_000

/**
 * The answers a template run is handed: the form's values and files, plus the
 * board project the results belong to.
 */
export interface TemplateAnswers extends TemplateValues {
  /** The project the jobs and the composed files are adopted into, when the form had one. */
  readonly projectId?: string
}

/** Why a chain stopped before its last step: what the log line says. */
export type ChainStop = 'failed' | 'cancelled' | 'no file' | 'timed out' | 'gone'

/** What a job came to, for the chain waiting on it: a file to continue from, or a stop. */
export type Produced =
  | { readonly kind: 'file'; readonly name: string }
  | { readonly kind: 'stopped'; readonly reason: ChainStop }

/**
 * What a template run needs from the studio.
 *
 * Written down so the chains can be driven by a fake queue in the tests: the
 * order of the steps and what stops them is the interesting part, and it does
 * not need a ComfyUI behind it.
 */
export interface TemplateQueue {
  /** Why the job route would refuse this body; undefined when it would queue it. */
  readonly check: (body: JobBody) => string | undefined
  /** Why a gallery file cannot be read by a run (missing, not a photo); undefined when it can. */
  readonly checkFile: (name: string) => Promise<string | undefined>
  /** Queue one run, exactly as the job route would. */
  readonly start: (body: JobBody) => Promise<{ readonly id: string }>
  /** What a job came to, once it has settled. */
  readonly produced: (id: string) => Promise<Produced>
  /** Compose a layout on the server, from a gallery file, into a gallery file. */
  readonly compose: (step: PlanCompose, sourceName: string | undefined) => Promise<string>
  /** Put composed files on a board project. */
  readonly adopt: (projectId: string, names: readonly string[]) => Promise<void>
}

/**
 * Why a name cannot be a template's photo: a path, a dot-file (ffmpeg's
 * intermediates and the compositions in progress are), or anything that is not
 * a picture — a clip or a song is a gallery file, but no template reads one.
 * @param name - the name a body offered.
 * @returns true when the name may be read as a photo.
 */
export function isTemplatePhotoName(name: string): boolean {
  return safeBasename(name) === name && !name.startsWith('.') && kindOf(name) === 'image'
}

/**
 * The queue a running studio offers: the job route's own checks and start,
 * the in-memory job map, ffmpeg in the media folder and the shared project
 * store.
 * @param routes - what a job needs from the boot.
 * @returns the queue.
 */
export function liveQueue(routes: JobStartContext): TemplateQueue {
  return {
    check: body => jobBodyProblem(body),
    checkFile: async (name) => {
      if (!isTemplatePhotoName(name)) return message('template.fileNotGallery', { name })
      const info = await stat(join(routes.outputDir, name)).catch(() => undefined)
      return info?.isFile() === true ? undefined : message('template.fileMissing', { name })
    },
    start: async body => await startFromBody(routes, body),
    produced: async id => await producedFile(id),
    compose: async (step, sourceName) => await composeTemplate(step, {
      outputDir: routes.outputDir,
      ...sourceName === undefined ? {} : { sourceName },
    }),
    adopt: async (projectId, names) => { await adoptJobsInto([projectId], [...names]).catch(() => undefined) },
  }
}

/** A template run: what was queued now, and the promise of the chains behind it. */
export interface TemplateRunResult {
  /** The ids of the jobs queued now. */
  readonly jobs: readonly string[]
  /** The files composed now (a collage, a resize: ffmpeg, answered at once). */
  readonly files: readonly string[]
  /**
   * The sentence of what stopped the run half way, when something did: the
   * jobs and files above had started, the rest of the plans were not run.
   */
  readonly error?: string
  /** Settles when every chain this run started has finished or stopped. */
  readonly done: Promise<void>
}

/**
 * Run a template's plans: check them all, queue the jobs, compose the layouts,
 * and leave the chains running in the background.
 * @param routes - what a job needs from the boot (queue, graphs, media folder).
 * @param template - the template the answers were given to.
 * @param answers - the form's answers, and the project they belong to.
 * @param queue - the studio's calls; the running one by default.
 * @returns the ids of the jobs queued now, the files composed now, the
 *   sentence of what stopped the run when it stopped half way, and the
 *   promise of the chains.
 * @throws {Error} a sentence for the user when nothing was started: a body
 *   the dry check refused, or a first run that failed.
 */
export async function runTemplate(
  routes: JobStartContext,
  template: Template,
  answers: TemplateAnswers,
  queue: TemplateQueue = liveQueue(routes),
): Promise<TemplateRunResult> {
  const projectId = answers.projectId
  const plans = expandTemplate(template, answers)
  const refused = await dryCheck(queue, plans, projectId)
  if (refused !== undefined) throw new Error(refused)
  const jobs: string[] = []
  const files: string[] = []
  const chains: Promise<void>[] = []
  let error: string | undefined
  for (const plan of plans) {
    try {
      if (plan.kind === 'job') {
        const job = await queue.start(bodyOf(plan, projectId, undefined))
        jobs.push(job.id)
        if (plan.then.length > 0) {
          chains.push(follow(queue, template.id, plan.then, projectId, { kind: 'job', id: job.id, action: plan.action }))
        }
        continue
      }
      const name = await queue.compose(plan, undefined)
      files.push(name)
      // The board draws a tile for a file a project lists, so a composition is
      // adopted the moment it exists — the chains below adopt their own steps.
      if (projectId !== undefined) await queue.adopt(projectId, [name])
      if (plan.then.length > 0) chains.push(follow(queue, template.id, plan.then, projectId, { kind: 'file', name }))
    } catch (failure: unknown) {
      const reason = failure instanceof Error ? failure.message : String(failure)
      // Nothing started: the plain refusal, as the job route gives it.
      if (jobs.length === 0 && files.length === 0) throw new Error(reason)
      error = message('template.partial', { count: jobs.length + files.length, reason })
      console.warn('[imagine] template run stopped half way:', template.id, reason)
      break
    }
  }
  return {
    jobs,
    files,
    ...error === undefined ? {} : { error },
    done: Promise.all(chains).then(() => undefined),
  }
}

/**
 * Check every plan before anything is queued: each job body (chain steps
 * included) against the job route's own checks, and each gallery file a run
 * reads.
 * @param queue - the studio's calls.
 * @param plans - the expanded runs.
 * @param projectId - the project the bodies carry.
 * @returns the first refusal, or undefined when every run would be accepted.
 */
async function dryCheck(
  queue: TemplateQueue,
  plans: readonly PlanJobOrCompose[],
  projectId: string | undefined,
): Promise<string | undefined> {
  const names = new Set<string>()
  const visit = (plan: PlanJobOrCompose): string | undefined => {
    if (plan.kind === 'job') {
      const refused = queue.check(bodyOf(plan, projectId, undefined))
      if (refused !== undefined) return refused
      if (plan.source?.kind === 'file') names.add(plan.source.name)
      if (plan.reference?.kind === 'file') names.add(plan.reference.name)
    } else {
      for (const name of plan.files) names.add(name)
    }
    for (const next of plan.then) {
      const refused = visit(next)
      if (refused !== undefined) return refused
    }
    return undefined
  }
  for (const plan of plans) {
    const refused = visit(plan)
    if (refused !== undefined) return refused
  }
  for (const name of names) {
    const refused = await queue.checkFile(name)
    if (refused !== undefined) return refused
  }
  return undefined
}

/**
 * The file a chain starts from: the one the step before produced, or the job
 * that is producing it.
 */
type Continuation =
  | { readonly kind: 'file'; readonly name: string }
  | { readonly kind: 'job'; readonly id: string; readonly action: string }

/**
 * Say in the log that a chain stopped before its end.
 * @param templateId - the template.
 * @param step - which step, as `step <n> (<action or layout>)`.
 * @param reason - why.
 */
function chainStopped(templateId: string, step: string, reason: string): void {
  console.warn('[imagine] template chain stopped:', templateId, step, reason)
}

/** A step as the log names it: its place in the chain and what it does. */
function stepName(index: number, step: PlanJobOrCompose | { readonly action: string }): string {
  const what = 'kind' in step ? (step.kind === 'job' ? step.action : step.layout) : step.action
  return `step ${String(index)} (${what})`
}

/**
 * Run a chain: the request has already been answered, and the first step of a
 * chain waits on a queue that takes minutes.
 *
 * A step that fails or is cancelled ends its chain: the rest of it was written
 * to continue that file, and a broken link cannot be guessed. Every such end is
 * written to the log, with the template and the step.
 * @param queue - the studio's calls.
 * @param templateId - the template, for the log line.
 * @param steps - the chain, in order.
 * @param projectId - the project the steps are adopted into, when any.
 * @param from - where the chain starts.
 * @returns a promise that settles when the chain has finished or stopped.
 */
async function follow(
  queue: TemplateQueue,
  templateId: string,
  steps: readonly PlanJobOrCompose[],
  projectId: string | undefined,
  from: Continuation,
): Promise<void> {
  // Step 0 is the run the chain hangs off; its own steps count from 1.
  let current = from.kind === 'job' ? stepName(0, { action: from.action }) : 'step 0 (compose)'
  try {
    let source: string
    if (from.kind === 'file') {
      source = from.name
    } else {
      const first = await queue.produced(from.id)
      if (first.kind === 'stopped') {
        chainStopped(templateId, current, first.reason)
        return
      }
      source = first.name
    }
    // A step may carry a chain of its own (the engine allows it, the catalog
    // does not use it yet): it runs on that step's file, in order, before the
    // rest of this one.
    let index = 0
    const walk = async (chain: readonly PlanJobOrCompose[], start: string): Promise<boolean> => {
      let previous = start
      for (const step of chain) {
        index += 1
        current = stepName(index, step)
        const produced = await runStep(queue, step, projectId, previous)
        if (produced.kind === 'stopped') {
          chainStopped(templateId, current, produced.reason)
          return false
        }
        previous = produced.name
        if (step.then.length > 0 && !await walk(step.then, produced.name)) return false
      }
      return true
    }
    await walk(steps, source)
  } catch (error: unknown) {
    chainStopped(templateId, current, error instanceof Error ? error.message : String(error))
  }
}

/**
 * One step of a chain: queue it, wait for it, adopt what it produced.
 * @param queue - the studio's calls.
 * @param step - the step, already expanded.
 * @param projectId - the project the step is adopted into, when any.
 * @param previous - the file the chain has in hand.
 * @returns the produced file, or why the step did not get there.
 */
async function runStep(
  queue: TemplateQueue,
  step: PlanJobOrCompose,
  projectId: string | undefined,
  previous: string,
): Promise<Produced> {
  if (step.kind === 'job') {
    const job = await queue.start(bodyOf(step, projectId, previous))
    // `start` adopts the job into its project; its files are folded into the
    // project when it finishes (`adoptJobFiles`).
    return await queue.produced(job.id)
  }
  const name = await queue.compose(step, previous)
  if (projectId !== undefined) await queue.adopt(projectId, [name])
  return { kind: 'file', name }
}

/** How a chain watches one job: the job map, a wake-up, and the clock. */
export interface JobWatch {
  /** The job as it stands now, when it is still known. */
  readonly job: (id: string) => Pick<ImagineJob, 'status' | 'files'> | undefined
  /** Resolve once the job settles, or after `ms` at most. */
  readonly settle: (id: string, ms: number) => Promise<void>
  /** Now, in milliseconds. */
  readonly now: () => number
}

/** The studio's own job map and clock. */
const LIVE_WATCH: JobWatch = {
  job: id => getImagineJob(id),
  settle: async (id, ms) => { await whenJobsSettle([id], ms) },
  now: () => Date.now(),
}

/**
 * What a queued job came to, once it has settled.
 *
 * Waits for as long as the job is queued — a template queues several runs on
 * one GPU, and the last of them may start an hour later — and gives up only
 * on a job that has been running past {@link CHAIN_RUNNING_TIMEOUT_MS}. The
 * wait wakes on the job's own writes and once every {@link CHAIN_WAKE_MS}
 * to measure that.
 * @param id - the job.
 * @param watch - the job map and the clock; the studio's by default.
 * @returns its first file, or why there is none: it failed, was cancelled,
 *   produced nothing, ran too long, or is no longer known.
 */
export async function producedFile(id: string, watch: JobWatch = LIVE_WATCH): Promise<Produced> {
  let runningSince: number | undefined
  for (;;) {
    const job = watch.job(id)
    if (job === undefined) return { kind: 'stopped', reason: 'gone' }
    if (job.status === 'done') {
      const name = job.files?.[0]?.name
      return name === undefined ? { kind: 'stopped', reason: 'no file' } : { kind: 'file', name }
    }
    if (job.status === 'error') return { kind: 'stopped', reason: 'failed' }
    if (job.status === 'cancelled') return { kind: 'stopped', reason: 'cancelled' }
    if (job.status === 'running') runningSince ??= watch.now()
    if (runningSince !== undefined && watch.now() - runningSince >= CHAIN_RUNNING_TIMEOUT_MS) {
      return { kind: 'stopped', reason: 'timed out' }
    }
    await watch.settle(id, CHAIN_WAKE_MS)
  }
}

/**
 * One planned job as the body the job route reads: the same field names, so
 * the checks, the queue and the project adoption are the route's own.
 * @param plan - the run, every value already filled in.
 * @param projectId - the project the job is adopted into, when any.
 * @param previous - the file the chain has in hand, for a `previous` source.
 * @returns the request body.
 */
function bodyOf(plan: PlanJob, projectId: string | undefined, previous: string | undefined): JobBody {
  const source = plan.source?.kind === 'file' ? plan.source.name : previous
  const reference = plan.reference?.kind === 'file' ? plan.reference.name : undefined
  return {
    action: plan.action,
    prompt: plan.prompt,
    // One run per plan: a `count` would make the step a batch, and the chain
    // continues from a single file.
    count: 1,
    ...source === undefined ? {} : { source },
    ...reference === undefined ? {} : { reference },
    ...plan.aspectRatio === undefined ? {} : { aspectRatio: plan.aspectRatio },
    ...plan.seconds === undefined ? {} : { seconds: plan.seconds },
    ...projectId === undefined ? {} : { projectId },
  }
}
