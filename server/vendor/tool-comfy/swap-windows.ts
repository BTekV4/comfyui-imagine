/**
 * The object swap's render: one prompt for the whole clip, by a graph that
 * loops its own windows — plus the render hooks the runner's multi-render
 * actions share (one render, the join of its pieces, the seed per piece).
 *
 * The host used to chain the windows itself (a 24 fps plate, a window plan on
 * the clip's own cuts, each window rendered from the previous one's tail);
 * since 2026-11-07 every shipped swap graph plans and joins its own clips, and
 * that path was removed on 2026-11-15.
 * @module tool-comfy/swap-windows
 */

import { declaredOutputPath } from './index.ts'
import type { ComfyChainLink, ComfyProducedFile, LoadedWorkflow } from './index.ts'
import type { ResolvedInputVideo } from './input-image.ts'
import type { ImagineJob } from './job-queue.ts'

/** What one render of a run may change against the job's own values. */
export interface RenderOver {
  /** The file the render is declared under. */
  readonly path?: string
  /** A segment's own length (an animated background's). */
  readonly seconds?: number
  /** The clip this render reads instead of the job's (a «Regenerate detail» window's draft). */
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

/** What the swap renders with: the run's output directory, its job and its render. */
export interface SwapRun {
  readonly outputDir: string
  readonly job: ImagineJob
  /** The run's own seed. */
  readonly seed: number
  readonly render: Render
}

/**
 * The name the run's files are declared under, and with it the prefix the
 * gallery reads a file's origin from.
 */
const PRODUCED_TOOL = 'object_swap'

/**
 * A seed for one render: a segment steps by one prime, an attempt by another.
 * @param base - the run's seed.
 * @param slot - the segment's index.
 * @param attempt - the take's index.
 * @returns the seed, inside ComfyUI's 32-bit range.
 */
export function nextSeed(base: number, slot = 0, attempt = 0): number {
  return (base + 104729 * slot + 7919 * attempt) % 0xffffffff
}

/**
 * A swap graph that loops its own windows (H3 Relay 2.0) renders the clip in
 * one prompt: the windows, the history between them and the soundtrack come
 * from inside the graph, so there is nothing here to resample, plan, join or
 * dub. The graph says so itself — it carries the native loop nodes — which
 * keeps this a property of the file rather than a flag to keep in step.
 * @param workflow - the loaded graph.
 * @returns true when the graph carries a loop start.
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
