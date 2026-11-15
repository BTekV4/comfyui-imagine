/**
 * Two clip edits the canvas offers on its own, as Grok Imagine's video bar
 * does (2026-10-17): Taglia keeps a stretch of a clip, Unisci plays several
 * clips one after the other. Both write a new gallery file beside the inputs
 * and never touch them.
 */
import { join } from 'node:path'
import { message } from './messages.ts'
import { AAC_192K, FASTSTART, ffmpegTo, h264Out, probeMedia } from '../vendor/tool-comfy/media-tools.ts'
import { galleryEditRoute, galleryName, HttpError, stamp, stem } from './route-kit.ts'
import type { Handler } from './host.ts'

const clipName = (value: unknown): string | undefined => galleryName(value, 'video')

/*
 * CRF 16 with the `medium` preset, a notch finer than the joins' default 17.
 * The merge keeps its own concat graph instead of `joinCuts`:
 * it fits every clip to 30 fps and fills a silent clip with silence, which the
 * montage's join does not.
 */
const ENCODE = [...h264Out(16, 'medium'), ...FASTSTART, ...AAC_192K]

export function createTrimRoute(outputDir: string): Handler {
  return galleryEditRoute(outputDir, {
    failure: { status: 500, what: 'clip.trimFailed' },
    async run(body) {
      const name = clipName(body['name'])
      const start = typeof body['start'] === 'number' && Number.isFinite(body['start']) ? Math.max(0, body['start']) : undefined
      const end = typeof body['end'] === 'number' && Number.isFinite(body['end']) ? body['end'] : undefined
      if (name === undefined) throw new HttpError(400, message('clip.videoRequired'))
      if (start === undefined || end === undefined || end - start < 0.2) throw new HttpError(400, message('clip.selectionTooShort'))
      const input = join(outputDir, name)
      const { duration } = await probeMedia(input)
      if (duration <= 0) throw new HttpError(400, message('media.videoUnreadable'))
      if (start >= duration) throw new HttpError(400, message('clip.startPastEnd'))
      const stop = Math.min(end, duration)
      const output = `trim_video-${stem(name)}-${String(Math.round(start * 1000))}-${String(Math.round(stop * 1000))}.mp4`
      const target = join(outputDir, output)
      // Re-encoded, not stream-copied: a copy can only cut on keyframes, and
      // the cut must land on the frame the user stopped the handle on.
      await ffmpegTo(target, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', start.toFixed(3), '-to', stop.toFixed(3), '-i', input, ...ENCODE, target], 600_000)
      return { output, origin: { action: 'trim', prompt: message('origin.trim', { start: start.toFixed(1), stop: stop.toFixed(1) }), source: name } }
    },
  })
}

export function createMergeRoute(outputDir: string): Handler {
  return galleryEditRoute(outputDir, {
    failure: { status: 500, what: 'clip.mergeFailed' },
    async run(body) {
      const names = Array.isArray(body['names']) ? body['names'].map(clipName) : []
      if (names.length < 2 || names.length > 20 || names.some(entry => entry === undefined)) {
        throw new HttpError(400, message('clip.videoCount'))
      }
      const clips = names as string[]
      const inputs = clips.map(entry => join(outputDir, entry))
      // One ffprobe per clip gives length, sound and, for the first, the frame.
      const facts = await Promise.all(inputs.map(probeMedia))
      const first = facts[0]
      if (first?.width === undefined || first.height === undefined) throw new HttpError(400, message('clip.firstSizeUnreadable'))
      // Every clip onto the first one's frame and rate; a clip with no sound
      // gets silence for its length, so the soundtrack stays in step.
      const w = first.width - (first.width % 2)
      const h = first.height - (first.height % 2)
      const parts: string[] = []
      const extra: string[] = []
      let silent = 0
      facts.forEach((fact, index) => {
        parts.push(`[${String(index)}:v]scale=${String(w)}:${String(h)}:force_original_aspect_ratio=decrease,pad=${String(w)}:${String(h)}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${String(index)}]`)
        if (fact.hasAudio) {
          parts.push(`[${String(index)}:a]aresample=48000,aformat=channel_layouts=stereo[a${String(index)}]`)
        } else {
          const source = clips.length + silent
          silent += 1
          extra.push('-f', 'lavfi', '-t', fact.duration.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
          parts.push(`[${String(source)}:a]anull[a${String(index)}]`)
        }
      })
      const chain = facts.map((_fact, index) => `[v${String(index)}][a${String(index)}]`).join('')
      const graph = `${parts.join(';')};${chain}concat=n=${String(clips.length)}:v=1:a=1[v][a]`
      const output = `merge_video-${stem(clips[0] ?? 'clip')}-${String(clips.length)}-${stamp()}.mp4`
      const target = join(outputDir, output)
      await ffmpegTo(target, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs.flatMap(path => ['-i', path]), ...extra, '-filter_complex', graph, '-map', '[v]', '-map', '[a]', ...ENCODE, target], 1_200_000)
      return { output, origin: { action: 'merge', prompt: message('origin.merge', { count: clips.length }), source: clips[0] } }
    },
  })
}
