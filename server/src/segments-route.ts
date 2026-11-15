/**
 * «Segmenti» over HTTP.
 *
 * - `GET /api/segments?name=<photo>`: where the photo's analysis stands.
 * - `POST /api/segments` `{ name, again? }`: start it (or start it over with
 *   `again`); answers at once, the page asks the state until it is ready.
 * - `GET /api/segments/file/<photo>/<file>`: a mask or a cut-out.
 * - `GET /api/segments/zip?name=<photo>`: every cut-out, as one ZIP («Scarica tutto»).
 * @module segments-route
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSegmentFile, segmentsDir, segmentsStatus, startSegments, storedSegments } from '../vendor/tool-comfy/segments.ts'
import { streamMediaZip } from '../vendor/tool-comfy/media-zip.ts'
import { segmentZipNames } from '../../shared/imagine-segments.ts'
import { message } from './messages.ts'
import { galleryName, methods, readObject, restOf, sendJson } from './route-kit.ts'
import type { ImagineHost, WebRoute } from './host.ts'

export function createSegmentsRoutes(ctx: ImagineHost, outputDir: string): WebRoute[] {
  const photoOf = (value: unknown): string | undefined => galleryName(value, 'image')
  return [
    {
      kind: 'exact',
      path: '/api/segments',
      handler: methods({
        GET: async (req, res) => {
          const photo = photoOf(new URL(req.url ?? '/', 'http://x').searchParams.get('name'))
          if (photo === undefined) { sendJson(res, 400, { error: message('still.photoRequired') }); return }
          sendJson(res, 200, await segmentsStatus(photo))
        },
        POST: async (req, res) => {
          const body = await readObject(req)
          const photo = photoOf(body['name'])
          if (photo === undefined) { sendJson(res, 400, { error: message('still.photoRequired') }); return }
          sendJson(res, 200, await startSegments(ctx, outputDir, photo, body['again'] === true))
        },
      }),
    },
    {
      kind: 'exact',
      path: '/api/segments/zip',
      handler: methods({
        GET: async (req, res) => {
          const photo = photoOf(new URL(req.url ?? '/', 'http://x').searchParams.get('name'))
          const index = photo === undefined ? undefined : await storedSegments(photo)
          if (photo === undefined || index === undefined) { sendJson(res, 404, { error: message('segments.fileMissing') }); return }
          const parts = index.segments.filter(segment => isSegmentFile(segment.cut))
          await streamMediaZip(segmentsDir(photo), parts.map(segment => segment.cut), res, new Date(), {
            entries: segmentZipNames(parts.map(segment => segment.label)),
            filename: 'segments.zip',
          })
        },
      }),
    },
    {
      kind: 'prefix',
      path: '/api/segments/file',
      handler: methods({
        GET: async (req, res) => {
          const rest = restOf(req, res, '/api/segments/file')
          if (rest === undefined) return
          const [photo, file, ...more] = rest.split('/')
          if (more.length > 0 || photoOf(photo) === undefined || file === undefined || !isSegmentFile(file)) {
            sendJson(res, 404, { error: message('segments.fileMissing') })
            return
          }
          let bytes: Buffer
          try {
            bytes = await readFile(join(segmentsDir(photo!), file))
          } catch {
            sendJson(res, 404, { error: message('segments.fileMissing') })
            return
          }
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length, 'cache-control': 'private, max-age=86400' })
          res.end(req.method === 'HEAD' ? undefined : bytes)
        },
      }),
    },
  ]
}
