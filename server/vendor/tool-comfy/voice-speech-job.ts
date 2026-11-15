/**
 * The `voice` job through the speech service: the track is transcribed, then
 * read back out in the voice the service carries.
 *
 * The ComfyUI voice changer needs a face model per voice and keeps the music by
 * separating the mix. The speech service works the other way round — it says
 * the words again — so it is used only when the deployment asks for it
 * (`tts.voiceChange: tts`), and only what is spoken survives: a backing track
 * does not. A clip gets the clip back, with the new track muxed over its
 * picture, the same answer the graph path gives.
 * @module tool-comfy/voice-speech-job
 */

import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { message } from '../../src/messages.ts'
import { kindOf, safeBasename } from './gallery.ts'
import { rememberOrigin } from './imagine-notes.ts'
import {
  endRunControl, isSettled, patchJob, putJob, startRunControl, type ImagineJob, type SpeakTarget,
} from './job-queue.ts'
import type { ImagineJobRequest } from './job-request.ts'
import { ffmpegTo, muxAudio } from './media-tools.ts'
import { serviceError, speech } from './speak-job.ts'

/**
 * How long transcribing and reading a track back out may take together.
 *
 * Longer than the `speak` deadline on purpose: this job carries two requests to
 * the service, and the model may be loaded from nothing between them.
 */
const VOICE_TIMEOUT_MS = 900_000

/**
 * Queue a `voice` job that goes through the speech service.
 *
 * Started before the request checks that look for the RVC graph's pins: this
 * path reads no graph time.
 * @param target - the configured speech endpoint.
 * @param outputDir - the validated media output directory.
 * @param request - the studio request; `source` is the track or the clip.
 * @returns the queued job, before the track exists.
 */
export function startVoiceThroughSpeech(
  target: SpeakTarget,
  outputDir: string,
  request: ImagineJobRequest,
): ImagineJob {
  const job: ImagineJob = {
    id: randomUUID(),
    action: 'voice',
    prompt: request.prompt ?? '',
    status: 'queued',
    createdAt: Date.now(),
    ...request.source === undefined ? {} : { source: request.source },
    ...request.voice === undefined ? {} : { voice: request.voice },
  }
  putJob(job.id, job)
  void voiceInto(target, outputDir, job)
  return job
}

/** One transcription and one synthesis, run behind the job they belong to. */
async function voiceInto(target: SpeakTarget, outputDir: string, job: ImagineJob): Promise<void> {
  patchJob(job.id, { status: 'running', startedAt: Date.now() })
  const controller = startRunControl(job.id)
  const timer = setTimeout(() => { controller.abort() }, VOICE_TIMEOUT_MS)
  timer.unref()
  const base = target.baseURL.replace(/\/+$/, '')
  const scratch: string[] = []
  try {
    const name = job.source === undefined ? undefined : safeBasename(job.source)
    if (name === undefined) throw new Error(message('voice.sourceRequired'))
    const path = join(outputDir, name)
    const kind = kindOf(name)
    if (kind !== 'audio' && kind !== 'video') throw new Error(message('voice.sourceRequired'))
    /*
     * A clip is a track with pictures on it: the service wants the track, and a
     * mono 16 kHz copy is what an ASR asks for anyway.
     */
    let track = path
    let trackName = basename(path)
    if (kind === 'video') {
      track = join(tmpdir(), `voice-source-${job.id}.wav`)
      scratch.push(track)
      await ffmpegTo(track, ['-v', 'error', '-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', track], 600_000)
      trackName = 'voice.wav'
    }
    const text = await transcribe(target, base, trackName, await readFile(track), controller.signal)
    if (text.length === 0) throw new Error(message('voice.noTranscript'))
    // The same words, read out in the voice the job asked for.
    const spoken = await speech(target, text, job.voice ?? target.voice, controller.signal)
    // A cancel that landed while the audio was on its way wins: no file.
    if (isSettled(job.id)) return
    const short = job.id.replace(/-/g, '').slice(0, 8)
    const outName = kind === 'video' ? `voice_clip-${short}.mp4` : `voice_text-${short}.${target.format}`
    const outPath = join(outputDir, outName)
    if (kind === 'video') {
      const trackFile = join(tmpdir(), `voice-new-${job.id}.${target.format}`)
      scratch.push(trackFile)
      await writeFile(trackFile, spoken)
      await muxAudio(path, trackFile, outPath, { pad: true, faststart: true, timeoutMs: 600_000 })
    } else {
      await writeFile(outPath, spoken)
    }
    await rememberOrigin(outName, { action: 'voice', prompt: job.prompt })
    patchJob(job.id, {
      status: 'done',
      updatedAt: Date.now(),
      files: [{ name: outName, kind: kind === 'video' ? 'video' : 'audio' }],
    })
  } catch (error) {
    if (isSettled(job.id)) return
    patchJob(job.id, {
      status: 'error',
      updatedAt: Date.now(),
      error: controller.signal.aborted
        ? message('speak.timeout')
        : error instanceof Error ? error.message : message('voice.failed'),
    })
  } finally {
    clearTimeout(timer)
    endRunControl(job.id)
    await Promise.all(scratch.map(file => rm(file, { force: true }).catch(() => undefined)))
  }
}

/** The words spoken in the track, as the service heard them. */
async function transcribe(
  target: SpeakTarget,
  base: string,
  name: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData()
  form.set('file', new Blob([bytes as BlobPart]), name)
  form.set('model', target.asrModel ?? 'whisper-large-v3-turbo')
  form.set('response_format', 'json')
  const response = await fetch(`${base}/audio/transcriptions`, { method: 'POST', body: form, signal })
  if (!response.ok) throw await serviceError(response)
  const answer = await response.json() as { text?: unknown }
  return typeof answer.text === 'string' ? answer.text.trim() : ''
}
