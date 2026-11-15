/**
 * The scan of «Ricrea video»: it draws the opening frame before anything is
 * rendered — a set to choose from when the job is only the scan, one picture
 * when the run goes on to the render.
 * @module tool-comfy/scan-jobs
 */

import { message } from '../../src/messages.ts'
import { basename } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { probeMedia } from './media-tools.ts'
import type { LoadedWorkflow } from './index.ts'
import { scanCanvas } from './krea-draw.ts'
import { drawOpeningFrame, readReferenceClip } from './recreate-video.ts'
import { rememberOrigin } from './imagine-notes.ts'
import { adoptJobFiles } from './imagine-store.ts'
import type { WorkflowGraphs } from './workflow-fields.ts'
import { MAX_SCAN_CANDIDATES } from './job-request.ts'
import { isSettled, patchJob, setJobPromptId, type ImagineJob } from './job-queue.ts'
import type { ImagineFileOrigin } from './imagine-notes.ts'

/**
 * How many opening frames a «Ricrea video» scan draws when nobody says.
 *
 * Four: a frame is one draw of the clip's own opening — the scene cannot
 * move, only the take does — so the choice is narrow and each one costs ~20 s.
 */
const SCAN_FRAMES = 4

/** What a scan run needs from the runner. */
export interface ScanRun {
  readonly ctx: ImagineHost
  readonly workflows: WorkflowGraphs
  readonly outputDir: string
  readonly job: ImagineJob
  readonly signal: AbortSignal
}

/**
 * What the vision pass read in a reference clip, by the name of each opening
 * frame a «Ricrea video» scan drew from that reading.
 *
 * The recreation that starts from one of those frames is written from the
 * same reading: without this it read the clip again — about a minute of
 * vision — to learn what the scan had just learnt. In memory only and
 * bounded: after a restart, or for a frame from elsewhere, the clip is read
 * again as before.
 */
const readings = new Map<string, { readonly source: string; readonly frame: string; readonly motion?: string }>()

/** Most readings kept; the oldest go first. */
const MAX_READINGS = 200

function rememberReading(name: string, reading: { source: string; frame: string; motion?: string }): void {
  readings.delete(name)
  readings.set(name, reading)
  for (const oldest of readings.keys()) {
    if (readings.size <= MAX_READINGS) break
    readings.delete(oldest)
  }
}

/**
 * What every drawing of a run takes from its job: the recipe (`quality: 'high'`
 * or `speed: 'slow'` raise the steps to the graph's `steps.high`) and the
 * onPrompt/signal hooks.
 */
function drawOptsOf(run: ScanRun): {
  quality: ImagineJob['quality']
  speed: ImagineJob['speed']
  onPrompt: (promptId: string) => void
  signal: AbortSignal
} {
  return {
    quality: run.job.quality,
    speed: run.job.speed,
    onPrompt: (promptId) => { setJobPromptId(run.ctx, run.job.id, promptId) },
    signal: run.signal,
  }
}

/**
 * The graph a recreation draws its opening frame with: the second recipe of
 * `recreateFrame` (`pathHigh`) when the job asked for it, as `readJobRequest`
 * picks it for the scan, else the entry's own graph, else the plain generator.
 * @param workflows - the loaded graphs.
 * @param job - the recreation.
 * @returns the graph, or undefined when the deployment has none.
 */
function frameGraphOf(workflows: WorkflowGraphs, job: ImagineJob): LoadedWorkflow | undefined {
  const high = job.quality === 'high' || job.speed === 'slow' ? workflows.high?.recreateFrame : undefined
  return high ?? workflows.recreateFrame ?? workflows.generate
}

/**
 * Close a scan: file how each picture was made, then — unless the job was
 * ended from outside meanwhile — mark it done with the pictures and put them
 * on the board of the project it belongs to.
 * @param run - the scan's run.
 * @param names - the pictures drawn, in order.
 * @param origin - what the origin note of each picture says.
 * @param fields - what the finished job carries beside its files.
 */
async function finishScan(
  run: ScanRun,
  names: readonly string[],
  origin: ImagineFileOrigin,
  fields: Partial<ImagineJob>,
): Promise<void> {
  // Filed like any other production: the origin note is what lets the chat
  // and the tile menu say how each picture was made, and which clip it was
  // drawn for.
  await Promise.all(names.map(name => rememberOrigin(name, origin)))
  if (isSettled(run.job.id)) return
  patchJob(run.job.id, {
    ...fields,
    status: 'done',
    updatedAt: Date.now(),
    files: names.map(name => ({ name, kind: 'image' as const })),
  })
  await adoptJobFiles(run.job.id, [...names]).catch(() => undefined)
}

/** The reference clip read by the vision pass, with its canvas. */
async function readClip(run: ScanRun, sourceVideo: string): Promise<{
  reading: { frame: string; motion?: string }
  canvas: ReturnType<typeof scanCanvas>
}> {
  // One ffprobe for the size and the length.
  const { width, height, duration } = await probeMedia(sourceVideo)
  if (width === undefined || height === undefined) throw new Error(message('scan.videoSizeUnreadable'))
  const reading = await readReferenceClip(
    run.ctx,
    sourceVideo,
    duration,
    { width, height },
    `${run.job.id}-read`,
    run.job.model,
  )
  if (reading === undefined) throw new Error(message('scan.noVisionRead'))
  return { reading, canvas: scanCanvas(width, height) }
}

/**
 * The scan half of «Ricrea video»: the reference clip is read once, the
 * paragraph of its opening frame is written from that reading, and Krea 2
 * draws that frame N times. The job ends there, the pictures are on the
 * board, and the recreation starts from the one the user clicks.
 *
 * The job ends at the choice because the opening frame decides the whole
 * recreation — the pose, the wardrobe, the light of the clip it re-shoots —
 * and one draw was a lottery.
 *
 * ONE paragraph and N seeds, not N rewritten paragraphs: a recreation is
 * meant to be the clip's own opening, and a rewriter told to make the
 * candidates different would move the scene it exists to reproduce.
 * @param run - the scan's run.
 * @param frameWorkflow - the graph the job was queued with: `readJobRequest`
 *   already chose it, the second recipe included.
 * @param sourceVideo - the reference clip, when the job has one.
 */
export async function runScanFrame(run: ScanRun, frameWorkflow: LoadedWorkflow, sourceVideo: string | undefined): Promise<void> {
  const { ctx, outputDir, job } = run
  if (sourceVideo === undefined) throw new Error(message('job.recreateVideoRequired'))
  const { reading, canvas } = await readClip(run, sourceVideo)
  const total = Math.max(1, Math.min(MAX_SCAN_CANDIDATES, Math.round(job.candidates ?? SCAN_FRAMES)))
  const names: string[] = []
  for (let index = 0; index < total; index += 1) {
    // A cancel between two draws ends the set: the pictures already written
    // stay, and the user decides from a shorter row.
    if (isSettled(job.id)) break
    patchJob(job.id, { scanProgress: { done: index + 1, total } })
    const drawn = await drawOpeningFrame(ctx, frameWorkflow, outputDir, {
      paragraph: reading.frame, canvas, jobId: job.id, index: index + 1, ...drawOptsOf(run),
    })
    const name = basename(drawn)
    names.push(name)
    if (job.source !== undefined) {
      rememberReading(name, { source: job.source, frame: reading.frame, ...reading.motion === undefined ? {} : { motion: reading.motion } })
    }
  }
  await finishScan(run, names, {
    action: 'scanFrame',
    prompt: job.prompt,
    ...job.source === undefined ? {} : { source: job.source },
  }, {
    // The paragraph Krea 2 drew every candidate from: it is also what the
    // recreation's prompt is written from, and what to read when the frames
    // came out wrong.
    writtenPrompt: reading.frame,
  })
}

/**
 * «Ricrea video», first half: the reference clip is read moment by moment
 * and Krea 2 draws its opening frame again. The picture is what the render
 * starts from, and the reading stays in hand because the prompt written for
 * that render is built from the action it described.
 *
 * The clip is read even when the frame was handed in — a candidate from the
 * scan, or a retry — because the reading is also what the render's prompt is
 * written from: skipping it left `recreateBrief` with no motion at all, so
 * the recreation had a picture and no idea what happened in it. A candidate
 * the scan drew in this process is written from the reading the scan made.
 * @param run - the recreation's run.
 * @param sourceVideo - the reference clip.
 * @returns the opening frame (drawn now or handed in) and the motion read.
 */
export async function readRecreation(run: ScanRun, sourceVideo: string): Promise<{ frame: string; motion?: string }> {
  const { ctx, workflows, outputDir, job } = run
  const known = job.frame === undefined ? undefined : readings.get(job.frame)
  if (job.frame !== undefined && known !== undefined && known.source === job.source) {
    // A frame handed in carries the paragraph it was drawn from.
    patchJob(job.id, { writtenPrompt: known.frame })
    return { frame: job.frame, ...known.motion === undefined ? {} : { motion: known.motion } }
  }
  const { reading, canvas } = await readClip(run, sourceVideo)
  const motion = reading.motion === undefined ? {} : { motion: reading.motion }
  if (job.frame !== undefined) {
    // A frame handed in carries the paragraph it was drawn from.
    patchJob(job.id, { writtenPrompt: reading.frame })
    return { frame: job.frame, ...motion }
  }
  const frameWorkflow = frameGraphOf(workflows, job)
  if (frameWorkflow === undefined) throw new Error(message('scan.frameWorkflowNotConfigured'))
  const drawn = await drawOpeningFrame(ctx, frameWorkflow, outputDir, {
    paragraph: reading.frame, canvas, jobId: job.id, ...drawOptsOf(run),
  })
  const photo = basename(drawn)
  patchJob(job.id, { frame: photo, writtenPrompt: reading.frame })
  return { frame: photo, ...motion }
}
