/**
 * The studio's web build: the files of `webDir`, compressed with brotli or
 * gzip once per file version, with an ETag of size and mtime, and the page
 * itself for any path that is not a file (the studio routes on the client).
 * @module static
 */
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib'
import { coversDir, coverFileOf, coverKeyOf, coverPosterOf } from './covers.ts'
import { decodePath, rangeOf } from './route-kit.ts'
import { mediaTypeOfExt } from '../../shared/media-types.ts'

/**
 * The web build's own types. The media a cover can be (images, videos) come
 * from the studio's one table, `shared/media-types.ts`.
 */
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
}

/** The type a file of the build or a cover is served as. */
const mimeOf = (ext: string): string => MIME[ext] ?? mediaTypeOfExt(ext)?.mime ?? 'application/octet-stream'

/** Text types worth compressing; images and fonts already are. */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.webmanifest', '.txt'])

const brotliAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

/**
 * Compressed copies of the web build, made once per file version.
 *
 * The build is a few files that change only on deploy, so compressing each
 * the first time it is asked for and keeping the result costs a few hundred
 * KB of memory and saves ~70 % of the JS on every cold load.
 */
const packed = new Map<string, { readonly tag: string; readonly br: Promise<Buffer>; readonly gzip: Promise<Buffer> }>()

/**
 * More entries than one build has files: what is left belongs to bundles a
 * deploy has removed, which nobody asks for again, so the cache starts over.
 */
const PACKED_MAX = 300

function packedOf(file: string, tag: string): { br: Promise<Buffer>; gzip: Promise<Buffer> } {
  const known = packed.get(file)
  if (known?.tag === tag) return known
  if (packed.size >= PACKED_MAX) packed.clear()
  const raw = readFile(file)
  const entry = {
    tag,
    br: raw.then(bytes => brotliAsync(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } })),
    gzip: raw.then(bytes => gzipAsync(bytes, { level: 9 })),
  }
  // A failed read must not stay cached for the next request.
  entry.br.catch(() => { packed.delete(file) })
  entry.gzip.catch(() => { packed.delete(file) })
  packed.set(file, entry)
  return entry
}

/**
 * Serve one GET or HEAD from the web build.
 * @param webDir - the build's folder.
 * @param req - the request.
 * @param res - the response.
 * @param path - the request's pathname, still escaped.
 */
export async function serveStatic(webDir: string, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const decoded = decodePath(path)
  if (decoded === undefined) {
    res.writeHead(400).end()
    return
  }
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '')
  const isAsset = relative.startsWith('assets/')
  // Source maps stay on the box: the build is not published as source.
  if (relative.endsWith('.map')) {
    res.writeHead(404).end()
    return
  }
  const webRoot = resolve(webDir)
  /** Whether a path the request built still stays under the folder it is served from. */
  const inside = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(root + sep)
  let file = join(webRoot, relative)
  let info = inside(webRoot, file) ? await stat(file).catch(() => undefined) : undefined
  /*
   * A cover set by the user wins over the repo's one: it lives in the data
   * folder (`covers/<key>.<extension>`), so updating the code does not touch
   * it and replacing it needs no commit.
   *
   * The lookup is by KEY, without extension: since 4-11-2026 a cover can be a
   * video, and `covers/video.mp4` must also answer `/imagine/video.webp`, the
   * name by which the repo (and the card) call the image of the same action.
   * The type served is that of the file found, not that of the address.
   * `?repo=1` skips the override: it is the cards' fallback poster when the
   * video does not start.
   *
   * The data file lives OUTSIDE webDir, so the check that the path does not
   * escape the served folder must be made against the folder it is looked up
   * in: made against webDir it discarded the override, and index.html arrived
   * in its place with type `text/html` (the broken covers of 4-11-2026).
   */
  const query = new URL(req.url ?? '/', 'http://x').searchParams
  const repoCover = query.get('repo') === '1'
  /*
   * `?poster=1`: the poster of a personal video cover, i.e. its first frame
   * in `<data>/covers/<key>.poster.webp`. If there is none, the repo's image
   * is served, which is the fallback this address had before posters existed.
   * `?repo=1` stays as it was: that is the repo's image, always.
   */
  const wantPoster = query.get('poster') === '1'
  let personal = false
  if (relative.startsWith('imagine/') && !repoCover) {
    const name = relative.slice('imagine/'.length)
    const key = name.includes('/') ? undefined : coverKeyOf(name.replace(/\.[A-Za-z0-9]+$/, ''))
    const own = key === undefined
      ? undefined
      : wantPoster ? await coverPosterOf(coversDir(), key) : await coverFileOf(coversDir(), key)
    const ownInfo = own === undefined ? undefined : await stat(own.file).catch(() => undefined)
    if (own !== undefined && ownInfo !== undefined && ownInfo.isFile() && inside(resolve(coversDir()), own.file)) {
      file = own.file
      info = ownInfo
      personal = true
    }
  }
  if (info === undefined || info.isDirectory()) {
    /*
     * A missing cover is a 404, not the page: index.html under
     * /imagine/<key>.webp went out with the covers' day of cache, and a
     * browser that saw the public copy before its covers existed kept the
     * broken image for 24 hours (2026-11-15). Only names with a media
     * extension: /imagine/post/<id> is a route of the page.
     */
    const missingCover = relative.startsWith('imagine/') && /\.(webp|png|jpe?g|gif|avif|mp4|webm)$/i.test(relative)
    if (isAsset || missingCover) {
      res.writeHead(404).end()
      return
    }
    file = join(webRoot, 'index.html')
    info = await stat(file)
  }
  const ext = extname(file)
  const tag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`
  const headers: Record<string, string> = {
    'content-type': mimeOf(ext),
    // Hashed bundles never change; the covers change only on deploy, so a day
    // is safe; the page itself is revalidated (a 304 when nothing moved).
    'cache-control': isAsset
      ? 'public, max-age=31536000, immutable'
      : relative.startsWith('imagine/') ? 'public, max-age=86400' : 'no-cache',
    'etag': tag,
    'last-modified': new Date(info.mtimeMs).toUTCString(),
    'vary': 'accept-encoding',
    // A cover that is a video can be watched from the middle: the player asks
    // for a byte range, and without this header it does not ask at all.
    'accept-ranges': 'bytes',
  }
  /*
   * A personal cover is replaced from Settings, and with the repo files' one
   * day of cache the replacement would stay invisible until tomorrow: those
   * are always revalidated (the ETag changes with the file). The rest of
   * `imagine/` keeps the day from before.
   */
  if (personal) headers['cache-control'] = 'no-cache'
  if (req.headers['if-none-match'] === tag) {
    res.writeHead(304, headers).end()
    return
  }
  /*
   * Videos are served in ranges: Chromium asks for `bytes=0-` even for a
   * cover playing in a loop, and a server answering 200 with the whole file
   * makes it download it entirely instead of starting while it arrives.
   */
  const range = rangeOf(req.headers.range, info.size)
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${String(info.size)}` }).end()
    return
  }
  if (range !== undefined) {
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${String(range.start)}-${String(range.end)}/${String(info.size)}`,
      'content-length': String(range.end - range.start + 1),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const part = createReadStream(file, { start: range.start, end: range.end })
    part.on('error', () => { res.destroy() })
    part.pipe(res)
    return
  }
  const accepts = String(req.headers['accept-encoding'] ?? '')
  const encoding = !COMPRESSIBLE.has(ext) ? undefined : /\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : undefined
  if (encoding !== undefined) {
    let body: Buffer
    try {
      const entry = packedOf(file, tag)
      body = await (encoding === 'br' ? entry.br : entry.gzip)
    } catch {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { ...headers, 'content-encoding': encoding, 'content-length': String(body.length) })
    res.end(req.method === 'HEAD' ? undefined : body)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': String(info.size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  // A file a deploy removes between the stat and the open must not take the
  // process down with an unhandled stream error.
  const stream = createReadStream(file)
  stream.on('error', () => { res.destroy() })
  stream.pipe(res)
}
