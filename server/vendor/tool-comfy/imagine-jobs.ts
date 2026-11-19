/**
 * The Imagine job API: the studio page starts generate / remix / video runs
 * without blocking the HTTP request, and reads, cancels and prunes them.
 *
 * The work lives beside this file: the job map in `job-queue.ts`, the request
 * checks in `job-request.ts`, the runner in `run-job.ts` (with `scan-jobs.ts`,
 * `swap-windows.ts`, `job-finish.ts`), stories in `story-jobs.ts`, speech in
 * `speak-job.ts`. This module starts a request and re-exports what the routes
 * and the music-video chain read.
 * @module tool-comfy/imagine-jobs
 */

import { SWAP_PLAN_RESOLUTION } from '../../../shared/imagine-sizing.ts'
import { randomUUID } from 'node:crypto'
import type { ImagineHost } from '../../src/host.ts'
import type { ImagineWorkflows } from './workflow-fields.ts'
import { keepPaintedMask, putJob, type ImagineJob, type SpeakTarget } from './job-queue.ts'
import { MAX_JOB_COUNT, readJobRequest, routeRequest, type ImagineJobRequest } from './job-request.ts'
import { enqueueJob } from './run-job.ts'
import { startSpeak } from './speak-job.ts'
import { startVoiceThroughSpeech } from './voice-speech-job.ts'
import { startRedo, startResume, startStory } from './story-jobs.ts'

export {
  cancelImagineJob, getImagineJob, listImagineJobs, pruneOldJobs, whenJobsSettle,
  type ImagineJob, type SpeakTarget,
} from './job-queue.ts'
export { resumeUnfinishedStories } from './story-jobs.ts'

/**
 * Queue one or more Imagine runs and start them in the background.
 * When `count` > 1, a batch of jobs is created with different seeds.
 * @param ctx - plugin context carrying `comfy`.
 * @param workflows - the loaded generate / edit / video graphs.
 * @param outputDir - the validated media output directory.
 * @param request - the studio request.
 * @param speak - the speech endpoint, when the deployment has one.
 * @returns the first queued job (of the batch, or of the story's chain).
 */
export async function startImagineJob(
  ctx: ImagineHost,
  workflows: ImagineWorkflows,
  outputDir: string,
  request: ImagineJobRequest,
  speak?: SpeakTarget,
): Promise<ImagineJob> {
  if (request.action === 'speak') return startSpeak(speak, outputDir, request.prompt)
  /*
   * «Change voice» through the speech service when the deployment asks for it
   * (`tts.voiceChange: tts`): the track is transcribed and read back out. Taken
   * before the request checks, which look for the RVC graph's pins and have
   * nothing to hold this path to.
   */
  if (request.action === 'voice' && speak?.voiceChange === 'tts') {
    return startVoiceThroughSpeech(speak, outputDir, request)
  }
  request = await routeRequest(outputDir, request)
  if (request.action === 'story') return await startStory(ctx, workflows, outputDir, request)
  if (request.action === 'redo') return await startRedo(ctx, workflows, outputDir, request)
  if (request.action === 'resume') return await startResume(ctx, workflows, outputDir, request)
  const plan = await readJobRequest(workflows, outputDir, request)
  const action = request.action
  const recreate = action === 'recreate'
  const count = Math.max(1, Math.min(MAX_JOB_COUNT, request.count ?? 1))
  const batchId = count > 1 ? randomUUID() : undefined

  // When batch, create all jobs upfront so the UI can track them.
  const batchJobs: ImagineJob[] = []
  for (let i = 0; i < count; i++) {
    const id = randomUUID()
    const job: ImagineJob = {
      id,
      action,
      prompt: plan.prompt,
      status: 'queued',
      createdAt: Date.now(),
      ...plan.source === undefined ? {} : { source: plan.source },
      ...plan.reference === undefined ? {} : { reference: plan.reference },
      ...plan.objectMode === undefined ? {} : { objectMode: plan.objectMode },
      ...plan.placement === undefined ? {} : { placement: plan.placement },
      ...plan.light === undefined ? {} : { light: plan.light },
      ...plan.frame === undefined ? {} : { frame: plan.frame },
      ...action === 'scanFrame' && request.candidates !== undefined ? { candidates: request.candidates } : {},
      ...recreate && request.keepAudio === true ? { keepAudio: true } : {},
      ...action === 'swapPerson' && request.lipSync === false ? { lipSync: false } : {},
      // The swaps' step on a graph that plans its own clips: 720p keeps the graph's own 736p.
      ...(action === 'swapPerson' || action === 'objectSwap') && request.swapResolution !== undefined
        && SWAP_PLAN_RESOLUTION[request.swapResolution] !== undefined
        ? { planResolution: SWAP_PLAN_RESOLUTION[request.swapResolution] }
        : {},
      ...plan.recreateSeconds === undefined ? {} : { seconds: plan.recreateSeconds },
      /*
       * No length for an object swap: its graph plans its own clips on the
       * plate, and a length stamped here would land in the file's note as the
       * clip's duration, whatever the clip really lasts.
       *
       * The composer's size for the actions that have one, the clip's own
       * canvas for a recreation — never the composer's there, which would
       * letterbox or crop the reference. An object swap carries none: its
       * graph sizes the render from `planResolution`.
       */
      ...plan.size === undefined ? {} : { size: plan.size },
      ...request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio },
      ...request.seconds === undefined || recreate ? {} : { seconds: request.seconds },
      ...request.megapixels === undefined ? {} : { megapixels: request.megapixels },
      ...request.speed === undefined ? {} : { speed: request.speed },
      ...request.quality === undefined ? {} : { quality: request.quality },
      ...request.canvasAsked === true ? { canvasAsked: true } : {},
      ...action === 'upscale' && request.upscaleTo !== undefined ? { upscaleTo: request.upscaleTo } : {},
      ...plan.region === undefined ? {} : { region: plan.region },
      ...plan.target === undefined ? {} : { target: plan.target },
      ...plan.painted === undefined ? {} : { painted: true },
      ...plan.lastSource === undefined ? {} : { lastSource: plan.lastSource },
      ...request.lyrics === undefined ? {} : { lyrics: request.lyrics },
      ...request.voice === undefined ? {} : { voice: request.voice },
      ...request.pitch === undefined ? {} : { pitch: request.pitch },
      ...batchId === undefined ? {} : { batchId, batchIndex: i },
      ...request.model === undefined ? {} : { model: request.model },
      ...request.clipId === undefined ? {} : { clipId: request.clipId },
      ...request.singer === undefined ? {} : { singer: request.singer },
      ...request.customWorkflowId === undefined ? {} : { customWorkflowId: request.customWorkflowId },
      ...request.customFiles === undefined ? {} : { customFiles: request.customFiles },
      ...request.customFields === undefined ? {} : { customFields: request.customFields },
    }
    putJob(id, job)
    batchJobs.push(job)
  }
  // `enqueueJob` puts every job at the back of the one GPU chain, so a batch
  // runs one after the other; each deadline starts when that job begins.
  if (plan.painted !== undefined) for (const batchJob of batchJobs) keepPaintedMask(batchJob.id, plan.painted)
  for (const batchJob of batchJobs) enqueueJob(ctx, plan.workflow, workflows, outputDir, batchJob)
  // `count` is at least one: the batch is never empty.
  return batchJobs[0] as ImagineJob
}
