/**
 * "Estrai frame": one still out of a gallery clip, at the time the user
 * scrubbed to, saved beside the clip as a new gallery image.
 *
 * ffmpeg seeks with `-ss` before the input, which on a transcode is
 * frame-accurate (it decodes from the previous keyframe and drops what is
 * before the asked time), and writes a lossless PNG at the clip's own size.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { message } from './messages.ts'
import { frameAt } from '../vendor/tool-comfy/media-tools.ts'
import { galleryEditRoute, galleryName, HttpError, stem } from './route-kit.ts'
import type { Handler } from './host.ts'

/**
 * The file name a frame gets: the clip's stem and the time in milliseconds,
 * so the same instant asked twice lands on the same file instead of a copy.
 */
function frameName(clip: string, seconds: number): string {
  return `extract_frame-${stem(clip, 80)}-${String(Math.round(seconds * 1000)).padStart(6, '0')}.png`
}

export function createFrameRoute(outputDir: string): Handler {
  return galleryEditRoute(outputDir, {
    failure: { status: 400, what: 'frame.extractFailed' },
    async run(body) {
      const name = galleryName(body['name'], 'video')
      const time = typeof body['time'] === 'number' && Number.isFinite(body['time']) && body['time'] >= 0 ? body['time'] : undefined
      if (name === undefined) throw new HttpError(400, message('clip.videoNameRequired'))
      if (time === undefined) throw new HttpError(400, message('frame.timeRequired'))
      const output = frameName(name, time)
      const target = join(outputDir, output)
      try {
        await frameAt(join(outputDir, name), target, { at: time, timeoutMs: 60_000 })
        // ffmpeg past the last frame exits 0 and writes nothing: stat throws then.
        await stat(target)
      } catch (error: unknown) {
        if (/ENOENT/.test(error instanceof Error ? error.message : String(error))) throw new HttpError(400, message('frame.noneAtThatTime'))
        throw error
      }
      return { output, origin: { action: 'frame', prompt: message('origin.frame', { time: time.toFixed(2) }), source: name } }
    },
  })
}
