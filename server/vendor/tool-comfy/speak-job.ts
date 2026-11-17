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
import { readBodyTouched, speechClock, type SpeechClock } from './speech-silence.ts'

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
 * The error a speech service's refusal is reported with: its status and the
 * start of what it said.
 * @param response - the answer that was not ok.
 * @returns the error to throw.
 */
export async function serviceError(response: Response): Promise<Error> {
  const detail = await response.text().catch(() => '')
  return new Error(message('speak.serviceAnswered', { status: response.status, detail: detail.length === 0 ? '' : `: ${detail.slice(0, 200)}` }))
}

/**
 * Read a text out loud on the speech service (OpenAI's `/audio/speech`).
 *
 * The `speak` job and the `voice` job through the service sent the same
 * request each with its own copy until 2026-11-15; only the voice differs.
 *
 * The body is read chunk by chunk with the job's silence clock pushed back on
 * every piece: a service that sent its headers and then went quiet used to
 * hang a plain `arrayBuffer()` for good.
 * @param target - the configured speech endpoint.
 * @param text - what to say.
 * @param voice - the voice to say it in.
 * @param clock - the request's silence clock and the job's cancellation.
 * @returns the audio, in `target.format`.
 * @throws {Error} when the service refuses or the request fails or goes mute.
 */
export async function speech(target: SpeakTarget, text: string, voice: string, clock: SpeechClock): Promise<Uint8Array> {
  const response = await fetch(`${target.baseURL.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: target.model,
      input: text,
      voice,
      response_format: target.format,
    }),
    signal: clock.signal,
  })
  if (!response.ok) throw await serviceError(response)
  return await readBodyTouched(response, clock.touch)
}

/** One speech request, run behind the job it belongs to; a cancel aborts it. */
async function speakInto(target: SpeakTarget, outputDir: string, job: ImagineJob): Promise<void> {
  patchJob(job.id, { status: 'running', startedAt: Date.now() })
  const caller = startRunControl(job.id)
  const clock = speechClock(caller.signal)
  try {
    const bytes = await speech(target, job.prompt, target.voice, clock)
    // The service is done: filing the audio is local work, outside the clock.
    clock.stop()
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
      error: clock.expired()
        ? message('speak.timeout')
        : error instanceof Error ? error.message : message('speak.failed'),
    })
  } finally {
    clock.stop()
    endRunControl(job.id)
  }
}
