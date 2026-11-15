/**
 * The `speak` job: a line read out loud by a speech service, outside the GPU
 * queue.
 * @module tool-comfy/speak-job
 */

import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { message } from '../../src/messages.ts'
import { rememberOrigin } from './imagine-notes.ts'
import {
  endRunControl, isSettled, patchJob, putJob, startRunControl, type ImagineJob, type SpeakTarget,
} from './job-queue.ts'

/**
 * Read a line out loud and file the audio beside the other products.
 *
 * The service answers with the bytes, so there is no graph to queue and no
 * host to poll: the job is created queued and the request runs behind it, the
 * way a ComfyUI run does. The caller is not made to wait on it — the studio's
 * POST is what draws the tile, and a slow service would hold that request
 * open.
 * @param target - the configured speech endpoint, absent when the deployment
 *   has none.
 * @param outputDir - the validated media output directory.
 * @param prompt - the text to read.
 * @returns the queued job, before the audio exists.
 */
export function startSpeak(
  target: SpeakTarget | undefined,
  outputDir: string,
  prompt: string,
): ImagineJob {
  if (target === undefined) throw new Error(message('speak.actionNotConfigured'))
  const text = prompt.trim()
  if (text.length === 0) throw new Error(message('speak.textRequired'))
  const job: ImagineJob = {
    id: randomUUID(),
    action: 'speak',
    prompt: text,
    status: 'queued',
    createdAt: Date.now(),
  }
  putJob(job.id, job)
  void speakInto(target, outputDir, job)
  return job
}

/**
 * How long the speech service may take over one line.
 *
 * It runs outside the GPU queue, so the job deadline never reached it: a
 * service that stopped answering left the tile `running` for good.
 */
const SPEAK_TIMEOUT_MS = 300_000

/** One speech request, run behind the job it belongs to; a cancel aborts it. */
async function speakInto(target: SpeakTarget, outputDir: string, job: ImagineJob): Promise<void> {
  patchJob(job.id, { status: 'running', startedAt: Date.now() })
  const controller = startRunControl(job.id)
  const timer = setTimeout(() => { controller.abort() }, SPEAK_TIMEOUT_MS)
  timer.unref()
  try {
    const response = await fetch(`${target.baseURL.replace(/\/+$/, '')}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: target.model,
        input: job.prompt,
        voice: target.voice,
        response_format: target.format,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(message('speak.serviceAnswered', { status: response.status, detail: detail.length === 0 ? '' : `: ${detail.slice(0, 200)}` }))
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    // A cancel that landed while the audio was on its way wins: no file.
    if (isSettled(job.id)) return
    const name = `speak_text-${job.id.replace(/-/g, '').slice(0, 8)}.${target.format}`
    await writeFile(join(outputDir, name), bytes)
    await rememberOrigin(name, { action: 'speak', prompt: job.prompt })
    patchJob(job.id, { status: 'done', updatedAt: Date.now(), files: [{ name, kind: 'audio' }] })
  } catch (error) {
    if (isSettled(job.id)) return
    patchJob(job.id, {
      status: 'error',
      updatedAt: Date.now(),
      error: controller.signal.aborted
        ? message('speak.timeout')
        : error instanceof Error ? error.message : message('speak.failed'),
    })
  } finally {
    clearTimeout(timer)
    endRunControl(job.id)
  }
}
