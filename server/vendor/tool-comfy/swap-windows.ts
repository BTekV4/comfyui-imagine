/**
 * The windowed object swap: a plate rendered window after window, or in one
 * prompt by a graph that loops its own windows.
 * @module tool-comfy/swap-windows
 */

import { join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { message } from '../../src/messages.ts'
import { ComfyError } from '../comfyui/index.ts'
import { declaredOutputPath } from './index.ts'
import type { ComfyChainLink, ComfyProducedFile, LoadedWorkflow } from './index.ts'
import { resolveInputVideo, type ResolvedInputVideo } from './input-image.ts'
import { FPS } from './media-tools.ts'
import { renderedSeconds } from './montage.ts'
import {
  H3_JOIN_SECONDS, H3_LOW_CANVAS_WINDOW_FRAMES, H3_RETRY_WINDOW_FRAMES, H3_WINDOW_SECONDS,
  chainWindowPlate, layPlateAudio, planWindows, windowSecondsOf, type H3Window,
} from './h3-windows.ts'
import type { ImagineJob } from './job-queue.ts'

/** What one render of a run may change against the job's own values. */
export interface RenderOver {
  readonly path?: string
  readonly seconds?: number
  readonly windowStart?: number
  readonly video?: ResolvedInputVideo
}

/** One render of the run's graph. */
export type Render = (
  link: ComfyChainLink | undefined,
  seed: number,
  over?: RenderOver,
) => Promise<{ files: readonly ComfyProducedFile[] }>

/** The pieces of a chained render, joined into the run's one result. */
export type Assemble = (
  parts: readonly string[],
  lengths: readonly number[],
  errors: { readonly none: string; readonly unmeasured: string },
  finish: (assembled: string) => Promise<string>,
  fade?: number,
) => Promise<readonly ComfyProducedFile[]>

/** What the swap renders with: the run's graph, its job and its hooks. */
export interface SwapRun {
  readonly ctx: ImagineHost
  readonly outputDir: string
  readonly job: ImagineJob
  /** The run's own seed, stepped per window and per take. */
  readonly seed: number
  readonly signal: AbortSignal
  /** Files to delete however the run ends. */
  readonly scratch: string[]
  readonly render: Render
  readonly assemble: Assemble
}

/** The plate of a windowed swap, measured and planned once. */
export interface SwapPlate {
  /** The plate resampled to 24 fps; absent without a source. */
  readonly path?: string
  readonly seconds: number
  readonly plan: readonly H3Window[]
  /** Where the plate cuts, for the windows to land on. */
  readonly cuts: readonly number[]
}

/**
 * The name the run's files are declared under, and with it the prefix the
 * gallery reads a file's origin from.
 */
const PRODUCED_TOOL = 'object_swap'

/** A seed for one render: a window steps by one prime, an attempt by another. */
export function nextSeed(base: number, slot = 0, attempt = 0): number {
  return (base + 104729 * slot + 7919 * attempt) % 0xffffffff
}

/**
 * A swap graph that loops its own windows (H3 Relay 2.0) renders the clip in
 * one prompt: the windows, the history between them and the soundtrack come
 * from inside the graph, so there is nothing here to resample, plan, join or
 * dub. The graph says so itself — it carries the native loop nodes — which
 * keeps this a property of the file rather than a flag to keep in step.
 */
export function loopsItsOwnWindows(workflow: LoadedWorkflow): boolean {
  return Object.values(workflow.graph).some(node => SELF_LOOP_STARTS.has(node.class_type))
}

/**
 * The loop starts a graph can carry: the native one (H3 Relay 2.0) and the
 * Context-Loop pack's, which the openjutsu swap uses since 7-11-2026 — its
 * Swap Plan splits the clip into 6 s clips with a 39-frame overlap and the
 * Chain Assemble node joins them and lays the source soundtrack back.
 */
const SELF_LOOP_STARTS: ReadonlySet<string> = new Set(['StartLoop', 'MiniMaxH3ChainLoopStart'])

/**
 * The self-looping swap: one prompt for the whole clip.
 * @param run - the run's graph, job and hooks.
 * @returns the files the prompt produced.
 */
export async function renderRelay(run: SwapRun): Promise<readonly ComfyProducedFile[]> {
  const { job, outputDir } = run
  return (await run.render(
    undefined,
    nextSeed(run.seed),
    { path: declaredOutputPath(outputDir, PRODUCED_TOOL, 'mp4', { id: job.id, attempt: 0 }) },
  )).files
}

/**
 * One window after the other, and every window after the first renders from
 * a plate whose head is the previous window's own last frames.
 *
 * Two windows rendered from the plate alone are two different edits: the
 * graph pins the first frame of what it is given as the guide the whole
 * window grows from, and the plate's frame is the shot before the edit. The
 * head carries the window before it across the join instead — the edited
 * object, its light, its grain — and it is also the half second the join
 * dissolves over, at the same plate times on both sides, so the dissolve
 * blends one moment with itself. Measured on the old plan (2026-10-24): a
 * 13,5 jump between two frames at the join against a local 2,7 on a calm
 * clip, and half a second of the picture cut out per join under an untouched
 * soundtrack, so the last window ran a second ahead of its own audio.
 */
async function renderWindowPlan(
  run: SwapRun,
  h3Plate: string | undefined,
  windows: readonly H3Window[],
): Promise<readonly ComfyProducedFile[]> {
  const { job, outputDir } = run
  const parts: string[] = []
  const lengths: number[] = []
  let previous: { path: string; deliver: number } | undefined
  for (const [index, window] of windows.entries()) {
    let chained: ResolvedInputVideo | undefined
    if (previous !== undefined && h3Plate !== undefined) {
      const chainedPath = await chainWindowPlate({
        plate: h3Plate,
        previous: previous.path,
        previousDeliver: previous.deliver,
        start: window.start,
        seconds: window.seconds,
        overlap: window.overlap,
      })
      run.scratch.push(chainedPath)
      chained = await resolveInputVideo({ path: chainedPath })
    }
    const produced = await run.render(undefined, nextSeed(run.seed, index), {
      path: declaredOutputPath(outputDir, `${PRODUCED_TOOL}_part`, 'mp4', { id: job.id, index, attempt: 0 }),
      /*
       * The length the graph will really render, not the one the plan
       * wants: its own snap is `17k+5` and asking it a length off the grid
       * is what made a window come back shorter than planned. The plate
       * the window renders from is padded to match.
       */
      seconds: renderedSeconds(window.seconds),
      // The chained plate already begins where this window begins.
      windowStart: chained === undefined ? window.start : 0,
      ...chained === undefined ? {} : { video: chained },
    })
    const clip = produced.files.find(file => file.kind === 'video')
    if (clip === undefined) throw new Error(message('objectSwap.windowEmpty'))
    // The windows are disposable too: if the run dies before the join,
    // the final cleanup must take them away like the rest.
    run.scratch.push(clip.path)
    parts.push(clip.path)
    /*
     * The clip's own length, head included: the join dissolves exactly the
     * head away, so the finished file is as long as the plate and the
     * plate's own soundtrack stays on its own clock.
     */
    lengths.push(window.seconds)
    previous = { path: clip.path, deliver: window.deliver }
    /*
     * Every window asks ComfyUI for the same models again, and it keeps
     * what it loaded: the second window of the first real chain found the
     * card already full and took the GPU down with it. Freeing costs the
     * reload — a minute of a run that takes eight — and buys the chain.
     */
    if (index < windows.length - 1) {
      await run.ctx.comfy.freeMemory(run.signal).catch(() => undefined)
    }
  }
  const plate = h3Plate ?? (job.source === undefined ? undefined : join(outputDir, job.source))
  /*
   * The plate's audio wins over the generated one: the model was given it
   * as a reference and what it wrote is a guess about a room it only saw.
   */
  return run.assemble(parts, lengths, {
    none: message('objectSwap.noWindows'),
    unmeasured: message('objectSwap.sizeUnreadable'),
  }, async assembled => plate === undefined ? assembled : layPlateAudio(assembled, plate, outputDir), H3_JOIN_SECONDS)
}

/**
 * The window ladder: the plan the run asked for, then the same clip one
 * step down.
 *
 * A window is planned on a measurement, not on a guarantee — 362 frames at
 * 480p cost about what 192 at 544x928 cost, and the card is shared with
 * whatever else is loaded — so a window that does not fit is re-planned at
 * eight seconds and then at the native five instead of losing the whole clip
 * after its first window. Each step costs a render.
 */
function windowLadder(first: number): readonly number[] {
  const steps = [first, H3_LOW_CANVAS_WINDOW_FRAMES / FPS, H3_WINDOW_SECONDS, H3_RETRY_WINDOW_FRAMES / FPS]
  return steps.filter((seconds, index) => index === 0 || seconds < (steps[index - 1] ?? seconds) - 0.001)
}

/**
 * The windowed swap, down the ladder until a plan fits on the card.
 * @param run - the run's graph, job and hooks.
 * @param plate - the plate, measured and planned.
 * @returns the joined clip, with the plate's own soundtrack.
 */
export async function renderWindows(run: SwapRun, plate: SwapPlate): Promise<readonly ComfyProducedFile[]> {
  const ladder = windowLadder(windowSecondsOf(run.job))
  for (const [index, seconds] of ladder.entries()) {
    try {
      return await renderWindowPlan(
        run,
        plate.path,
        index === 0 ? plate.plan : planWindows(plate.seconds, seconds, H3_JOIN_SECONDS, plate.cuts),
      )
    } catch (error: unknown) {
      const last = index === ladder.length - 1
      if (last || !(error instanceof ComfyError) || error.code !== 'COMFY_OUT_OF_MEMORY') throw error
      console.warn(`[imagine] object swap: the ${seconds.toFixed(2)} s window does not fit the card, retrying at ${(ladder[index + 1] ?? H3_WINDOW_SECONDS).toFixed(2)} s`)
    }
  }
  throw new Error(message('objectSwap.noWindows'))
}
