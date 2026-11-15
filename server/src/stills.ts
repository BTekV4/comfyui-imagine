/**
 * Still edits the canvas offers on its own, as Grok Imagine's photo bar and
 * right-click menu do (2026-10-17): Ritaglia keeps a rectangle of a photo,
 * Duplica makes a second copy to work on. Both write a new gallery file beside
 * the original and never touch it — the viewer's old crop overwrote the photo
 * in place. "Rimuovi oggetto" belongs to the IOPaint plugin since 2026-11-15
 * (plugins/iopaint).
 */
import { copyFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { probePixels } from '../vendor/tool-comfy/gallery.ts'
import { regionOf } from '../vendor/tool-comfy/job-request.ts'
import { ffmpegTo } from '../vendor/tool-comfy/media-tools.ts'
import { message } from './messages.ts'
import { galleryEditRoute, galleryName, HttpError, stamp, stem } from './route-kit.ts'
import type { Handler } from './host.ts'

const stillName = (value: unknown): string | undefined => galleryName(value, 'image')

export function createCropRoute(outputDir: string): Handler {
  return galleryEditRoute(outputDir, {
    failure: { status: 500, what: 'still.cropFailed' },
    async run(body) {
      const name = stillName(body['name'])
      const region = regionOf(body['region'])
      if (name === undefined) throw new HttpError(400, message('still.photoRequired'))
      if (region === undefined) throw new HttpError(400, message('still.regionInvalid'))
      const input = join(outputDir, name)
      const pixels = await probePixels(input, 'image')
      if (!('width' in pixels)) throw new HttpError(400, message('still.sizeUnreadable'))
      // Even sides: the studio's video graphs refuse odd frames, and a crop is
      // often animated next.
      const w = Math.max(2, Math.round(region.w * pixels.width / 2) * 2)
      const h = Math.max(2, Math.round(region.h * pixels.height / 2) * 2)
      const x = Math.min(pixels.width - w, Math.max(0, Math.round(region.x * pixels.width)))
      const y = Math.min(pixels.height - h, Math.max(0, Math.round(region.y * pixels.height)))
      const output = `crop_image-${stem(name)}-${stamp()}.png`
      // PNG, lossless: a crop must not cost the photo a generation of quality.
      const target = join(outputDir, output)
      await ffmpegTo(target, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', `crop=${String(w)}:${String(h)}:${String(x)}:${String(y)}`,
        '-frames:v', '1', target], 120_000)
      return { output, origin: { action: 'crop', prompt: message('origin.crop', { width: w, height: h }), source: name } }
    },
  })
}

export function createDuplicateRoute(outputDir: string): Handler {
  return galleryEditRoute(outputDir, {
    failure: { status: 500, what: 'still.copyFailed' },
    async run(body) {
      const name = stillName(body['name'])
      if (name === undefined) throw new HttpError(400, message('still.photoRequired'))
      const output = `${stem(name)}-copia-${stamp()}${extname(name)}`
      await copyFile(join(outputDir, name), join(outputDir, output))
      return { output, origin: { action: 'duplicate', prompt: message('origin.copy'), source: name } }
    },
  })
}
