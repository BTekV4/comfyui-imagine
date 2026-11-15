/**
 * What every route shares, host and plugin alike: reading the body, answering
 * JSON, the 405, the path decode, the file stem and the gallery entry a new
 * file is answered with.
 *
 * Six route files carried their own copy of these until 2026-10-20, and
 * `tool-comfy` its own body reader and JSON writer until 2026-10-25.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { message, translateMessage, type MessageKey } from './messages.ts'
import { parse } from 'node:path'
import { galleryItemOf, kindOf, safeBasename } from '../vendor/tool-comfy/gallery.ts'
import { rememberOrigin, type ImagineFileOrigin } from '../vendor/tool-comfy/imagine-notes.ts'
import type { GalleryItem } from '../../shared/imagine-types.ts'
import type { Handler } from './host.ts'

/** A failure the client caused, answered with its own status instead of a 500. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** The largest JSON body a host route accepts (the erase mask is the biggest). */
export const MAX_JSON_BYTES = 32 * 1024 * 1024

/**
 * The request body as bytes, refused past `maxBytes` with an `HttpError(413)`.
 *
 * Past the limit this stops keeping the bytes but goes on reading them, so
 * the socket stays alive and the 413 reaches the browser: breaking out of an
 * async iterator over the request destroys the socket, and the browser then
 * reads "Failed to fetch" instead of a reason (how `/api/erase` answered a
 * mask past 32 MB until 2026-10-25). Node discards the rest of the upload
 * once the answer is sent.
 * @param req - the request.
 * @param maxBytes - the largest body accepted.
 * @returns the body.
 */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const tooLarge = (): HttpError => new HttpError(413, message('body.tooLarge'))
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume()
    return Promise.reject(tooLarge())
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let stopped = false
    req.on('data', (chunk: Buffer) => {
      if (stopped) return
      total += chunk.length
      if (total > maxBytes) {
        stopped = true
        chunks.length = 0
        reject(tooLarge())
        return
      }
      chunks.push(chunk)
    })
    // Bytes are gathered and decoded once by the caller: decoding chunk by
    // chunk split a multi-byte character across two chunks into U+FFFD.
    req.on('end', () => { if (!stopped) resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

/**
 * The request body parsed as JSON; an empty body is `{}`.
 * @param req - the request.
 * @param maxBytes - the largest body accepted; {@link MAX_JSON_BYTES} by default.
 * @throws {HttpError} 413 past the limit, 400 when the body is not JSON.
 */
export async function readJson(req: IncomingMessage, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const body = (await readBody(req, maxBytes)).toString('utf8')
  if (body === '') return {}
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new HttpError(400, message('json.invalid'))
  }
}

/**
 * The request body as a JSON object, whose fields the route still checks one
 * by one: a `null`, a number or a list is answered 400 here instead of
 * failing on the first field read as a 500.
 * @param req - the request.
 * @param maxBytes - the largest body accepted; {@link MAX_JSON_BYTES} by default.
 * @returns the object, typed as the fields the route reads: unchecked, so
 *   declare them optional and check each one.
 * @throws {HttpError} 413, or 400 when the body is not a JSON object.
 */
export async function readObject<T extends object = Record<string, unknown>>(
  req: IncomingMessage,
  maxBytes = MAX_JSON_BYTES,
): Promise<T> {
  const body = await readJson(req, maxBytes)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, message('json.objectRequired'))
  return body as T
}

/**
 * Answer JSON. A HEAD gets the headers and no body.
 * @param res - the response.
 * @param status - the HTTP status.
 * @param body - the value to serialise.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  /*
   * An error composed by the server goes out in the interface language: the
   * request has already put it on `res` (see main.ts), and this is the one
   * place every JSON answer goes through.
   */
  if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') {
    const language = (res as ServerResponse & { language?: string }).language
    body = { ...(body as Record<string, unknown>), error: translateMessage((body as { error: string }).error, language) }
  }
  writeJson(res, status, body)
}

/** Answer JSON as it is, the error untouched: {@link sendJson} without the translation. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(res.req.method === 'HEAD' ? undefined : text)
}

/**
 * Answer 405 with the methods the route does accept.
 * @param res - the response.
 * @param allow - the accepted methods, comma-separated.
 */
export function notAllowed(res: ServerResponse, allow: string): void {
  // A body, not an empty 405: Chromium surfaces a zero-byte response on a
  // keep-alive connection as net::ERR_ABORTED.
  res.setHeader('allow', allow)
  sendJson(res, 405, { error: message('route.methodNotAccepted') })
}

/**
 * Answer 405 unless the request uses one of `methods`.
 * @returns true when the route may go on.
 */
export function allowOnly(req: IncomingMessage, res: ServerResponse, ...methods: string[]): boolean {
  if (methods.includes(req.method ?? 'GET')) return true
  notAllowed(res, methods.join(', '))
  return false
}

/**
 * One handler per method; HEAD goes to GET, anything else is a 405 that
 * lists what the route accepts.
 * @param table - the handlers by method.
 * @returns the route handler.
 */
export function methods(table: Readonly<Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', Handler>>>): Handler {
  const allow = Object.keys(table).flatMap(method => method === 'GET' ? ['GET', 'HEAD'] : [method]).join(', ')
  return (req, res) => {
    const method = req.method === 'HEAD' ? 'GET' : req.method ?? 'GET'
    const handler = (table as Readonly<Record<string, Handler | undefined>>)[method]
    if (handler !== undefined) return handler(req, res)
    notAllowed(res, allow)
  }
}

/**
 * A request path with its `%`-escapes decoded, or undefined when they are
 * malformed.
 *
 * `decodeURIComponent` THROWS a `URIError` on a lone `%` or a truncated
 * sequence, and every caller that did not catch it answered 500 for a URL the
 * user typed wrong (`GET /comfy-media/%E0%A4%A`). The hosts here decode their
 * own prefix routes, so the guard belongs beside the other route helpers
 * rather than in each one.
 * @param path - the raw pathname, still escaped.
 * @returns the decoded path, or undefined when it cannot be decoded.
 */
export function decodePath(path: string): string | undefined {
  try {
    return decodeURIComponent(path)
  } catch {
    return undefined
  }
}

/**
 * The path a prefix route was asked for, after its prefix: decoded, without
 * the leading slash, `''` for the prefix itself.
 *
 * The decode, the 400 and the slice were pasted into every prefix handler
 * until 2026-11-07; a path that cannot be decoded is answered here.
 * @param req - the request.
 * @param res - the response, answered 400 when the path is malformed.
 * @param prefix - the route's prefix, e.g. `/comfy-imagine`.
 * @returns the rest of the path, or undefined when the request was answered.
 */
export function restOf(req: IncomingMessage, res: ServerResponse, prefix: string): string | undefined {
  const path = decodePath(new URL(req.url ?? '/', 'http://x').pathname)
  if (path === undefined) {
    sendJson(res, 400, { error: message('path.invalid') })
    return undefined
  }
  return path.slice(prefix.length).replace(/^\//, '')
}

/**
 * The interface language the client declares on every call
 * (`x-app-language`), for the messages the server composes.
 *
 * One reader for the host and the studio's routes: `main.ts` and
 * `imagine-routes.ts` each carried an identical copy until 2026-11-07.
 * @param req - the request.
 * @returns the code (`it`, `en-GB`), or undefined when the client did not say.
 */
export function languageOf(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-app-language']
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(value) ? value : undefined
}

/**
 * The language of a page the studio serves itself, before its own script has
 * run (the login form): the request carries no `x-app-language` then.
 *
 * The same order the page uses to choose (`locale-store.ts`): `?lang=` first,
 * then the `imagine_locale` cookie the page writes on every choice, then the
 * header when a script sent one. With none of the three the page is Italian,
 * as the studio is on a first visit — `Accept-Language` is not read, because
 * the page does not read the browser's language either.
 * @param req - the request.
 * @returns the code, or undefined when the request does not say.
 */
export function pageLanguageOf(req: IncomingMessage): string | undefined {
  const valid = (value: string | null | undefined): string | undefined =>
    typeof value === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(value) ? value : undefined
  const fromQuery = valid(new URL(req.url ?? '/', 'http://x').searchParams.get('lang'))
  if (fromQuery !== undefined) return fromQuery
  const cookie = String(req.headers.cookie ?? '').split(';').map(part => part.trim())
    .find(part => part.startsWith('imagine_locale='))?.slice('imagine_locale='.length)
  return valid(cookie) ?? languageOf(req)
}

/**
 * The language the studio around a request is shown in: the
 * `imagine_shown_locale` cookie the page rewrites at every load, else
 * {@link pageLanguageOf}. For the pages the server draws inside the studio's
 * own frame, which must match the page around them, not the choice.
 * @param req - the request.
 * @returns the code, or undefined when nothing says.
 */
export function shownLanguageOf(req: IncomingMessage): string | undefined {
  const shown = String(req.headers.cookie ?? '').split(';').map(part => part.trim())
    .find(part => part.startsWith('imagine_shown_locale='))?.slice('imagine_shown_locale='.length)
  return shown !== undefined && /^[a-z]{2}(-[A-Z]{2})?$/.test(shown) ? shown : pageLanguageOf(req)
}

/** A byte range requested with `range`. */
export interface ByteRange {
  readonly start: number
  readonly end: number
}

/**
 * The byte range a request asks for, if it asks for one.
 *
 * Only the single-range form (`bytes=0-1023`, `bytes=0-`, `bytes=-1024`):
 * videos use it, and a multi-range request is answered whole (allowed by the
 * spec, and simpler than a multipart).
 * @param header - the `range` header.
 * @param size - the file's length.
 * @returns the range, `invalid` when it cannot be satisfied, undefined when none is asked.
 */
export function rangeOf(header: string | undefined, size: number): ByteRange | 'invalid' | undefined {
  if (header === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return undefined
  const first = match[1] ?? ''
  const second = match[2] ?? ''
  if (first === '' && second === '') return undefined
  if (first === '') {
    // `bytes=-1024`: the last 1024 bytes.
    const length = Number(second)
    if (!Number.isFinite(length) || length <= 0) return 'invalid'
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(first)
  const end = second === '' ? size - 1 : Math.min(Number(second), size - 1)
  if (!Number.isFinite(start) || start >= size || end < start) return 'invalid'
  return { start, end }
}

/**
 * A gallery file name from a body field, when it names a file of that kind.
 * @param value - the untrusted field.
 * @param kind - the kind the route works on.
 * @returns the basename, or undefined.
 */
export function galleryName(value: unknown, kind: 'image' | 'video'): string | undefined {
  const name = typeof value === 'string' ? safeBasename(value) : undefined
  return name !== undefined && kindOf(name) === kind ? name : undefined
}

/**
 * Answer a failed edit with its status and the start of the reason.
 * @param res - the response.
 * @param status - 500 for our failure, 502 for a backend's, 400 for the input's.
 * @param what - the sentence's head, e.g. «taglio non riuscito».
 * @param error - what was thrown.
 */
export function sendFailure(res: ServerResponse, status: number, what: string, error: unknown): void {
  /*
   * The sentence's head is a fixed entry of the table, but here it is already
   * joined to the reason: `sendJson` would only find it whole. The head is
   * translated where it is composed, like the sentences with placeholders
   * (messages.ts).
   */
  const language = (res as ServerResponse & { language?: string }).language
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300)
  // Translated piece by piece already: the joined sentence matches no entry.
  writeJson(res, status, { error: `${translateMessage(what, language)}: ${translateMessage(reason, language)}` })
}

/** A file name's stem, safe to build a new gallery name from. */
export const stem = (name: string, max = 60): string => parse(name).name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, max)

/** A short time stamp that keeps two outputs of the same file apart. */
export const stamp = (): string => Date.now().toString(36)

/**
 * The gallery entry of a file a route just wrote, as the canvas places it:
 * the listing's own entry (`galleryItemOf`), so it carries the `tool` its
 * name declares and the listing's mtime (until 2026-10-25 a copy here left
 * `tool` out, and «Duplica» made a tile without its origin).
 * @param outputDir - the media directory.
 * @param name - the new file's basename.
 * @throws when the file is missing or is not gallery media.
 */
export async function galleryEntryOf(outputDir: string, name: string): Promise<GalleryItem> {
  const item = await galleryItemOf(outputDir, name)
  if (item === undefined) throw new Error(message('gallery.notAFile', { name }))
  return item
}

/** What one gallery edit made: the new file and how it came to be. */
export interface GalleryEdit {
  /** The new file's basename, in the media directory. */
  readonly output: string
  /** The note the Details panel and the history read. */
  readonly origin: ImagineFileOrigin
}

/**
 * The route of an edit that writes a new gallery file beside its inputs and
 * never touches them (trim, merge, crop, duplicate, erase, frame): POST only,
 * a JSON object body, the edit, the origin note and the new file's gallery
 * entry as the answer.
 *
 * The six routes each carried this skeleton until 2026-11-14.
 * @param outputDir - the media directory.
 * @param edit.run - reads the body and makes the file. A refusal is an
 *   `HttpError` (400 for the input, 502 for a backend's answer) and goes out
 *   with its own status and text; anything else thrown is a failure.
 * @param edit.failure - the status and the sentence's head of a failure, e.g.
 *   500 and «taglio non riuscito»: the reason follows it.
 * @returns the route handler.
 */
export function galleryEditRoute(outputDir: string, edit: {
  readonly run: (body: Readonly<Record<string, unknown>>) => Promise<GalleryEdit>
  readonly failure: { readonly status: number; readonly what: MessageKey }
}): Handler {
  return async (req, res) => {
    if (!allowOnly(req, res, 'POST')) return
    const body = await readObject(req)
    try {
      const made = await edit.run(body)
      // A note that cannot be written costs the Details panel a line, not the file.
      await rememberOrigin(made.output, made.origin).catch(() => undefined)
      sendJson(res, 200, await galleryEntryOf(outputDir, made.output))
    } catch (error: unknown) {
      if (error instanceof HttpError) sendJson(res, error.status, { error: error.message })
      else sendFailure(res, edit.failure.status, message(edit.failure.what), error)
    }
  }
}
