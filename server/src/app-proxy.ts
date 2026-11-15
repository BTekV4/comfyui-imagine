/**
 * Pass a web app through the studio, under `/apps/<name>/…`, behind Imagine's
 * login: the app listens on loopback and needs no address of its own. The
 * plugins that bring an app into the studio's rail use it (plugins/openjutsu,
 * plugins/iopaint, since 2026-11-15; before, the host mounted both itself).
 *
 * Two shapes of app: one built for the prefix (Openjutsu, Next.js with
 * `basePath: "/apps/openjutsu"`) gets the path as it is; one that answers at
 * its root (IOPaint, whose built frontend was patched to call the prefix)
 * gets it with the prefix dropped (`strip`).
 *
 * Openjutsu accepts only a loopback Host and refuses cross-site requests
 * (Next's same-origin checks): the pass sets Host to the target and drops
 * Origin, Referer and the Sec-Fetch-* headers. Bodies and answers are
 * streamed both ways (uploads of whole videos, SSE).
 * @module app-proxy
 */

import { request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { WebRoute } from './host.ts'
import { messageIn } from './messages.ts'
import { shownLanguageOf } from './route-kit.ts'

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)

/**
 * The page shown in the frame when the app does not answer. A plain-text 502
 * in a dark frame read as a blank page (2026-11-15, a fresh install with the
 * plugin and without the app): it says what is missing and what to do.
 * @param req - the request, for the page's language.
 * @param name - the app.
 * @param url - the address it was looked for at.
 * @param error - why the connection failed.
 * @returns the HTML.
 */
function unreachablePage(req: IncomingMessage, name: string, url: string, error: string): string {
  const language = shownLanguageOf(req)
  const title = escapeHtml(messageIn(language, 'app.unreachableTitle', { name }))
  const body = escapeHtml(messageIn(language, 'app.unreachableBody', { name, url }))
  const detail = escapeHtml(messageIn(language, 'app.unreachableDetail', { error }))
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#141414;color:#e8e8e8;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:520px;padding:32px 24px}h1{font-size:20px;font-weight:600;margin:0 0 12px}p{margin:0 0 12px;color:#bdbdbd}code{color:#8a8a8a;font-size:13px}</style></head>
<body><main><h1>${title}</h1><p>${body}</p><p><code>${detail}</code></p></main></body></html>`
}

/** Headers that belong to one hop and are not passed on. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'])

/** Headers dropped on the way in so the app's same-origin checks pass. */
const CROSS_SITE = new Set(['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'])

export interface AppTarget {
  /** Where requests arrive, e.g. `/apps/openjutsu`. */
  readonly prefix: string
  /**
   * The app's own address, e.g. `http://127.0.0.1:3000`; a function is read
   * at every request, so a plugin setting changed on the page applies at once.
   */
  readonly url: string | (() => string)
  /** Drop the prefix before passing the path on (the app answers at its root). */
  readonly strip: boolean
  /** The name used in errors and in the log. */
  readonly name: string
}

function forwardHeaders(headers: IncomingHttpHeaders, host: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP.has(key) || CROSS_SITE.has(key) || key === 'host') continue
    // Imagine's own login cookie stays with Imagine.
    if (key === 'cookie') {
      const kept = String(value).split(';').map(part => part.trim()).filter(part => part !== '' && !part.startsWith('imagine-auth=')).join('; ')
      if (kept !== '') out[key] = kept
      continue
    }
    out[key] = value
  }
  out['host'] = host
  return out
}

/**
 * The route that passes one app through.
 * @param target - the app and where it is mounted.
 * @returns a prefix route for the host's table.
 */
export function createAppProxyRoute(target: AppTarget): WebRoute {
  const handler = (req: IncomingMessage, res: ServerResponse): Promise<void> => new Promise((resolve) => {
    const address = typeof target.url === 'function' ? target.url() : target.url
    let base: URL
    try {
      base = new URL(address)
    } catch {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(unreachablePage(req, target.name, address, 'invalid URL'))
      resolve()
      return
    }
    const incoming = req.url ?? '/'
    let path = incoming
    if (target.strip) {
      path = incoming.slice(target.prefix.length)
      if (path === '' || path.startsWith('?')) path = `/${path}`
    }
    const upstream = request({
      hostname: base.hostname,
      port: base.port,
      method: req.method,
      path,
      headers: forwardHeaders(req.headers, base.host),
    }, (answer) => {
      const headers: Record<string, string | string[]> = {}
      for (const [key, value] of Object.entries(answer.headers)) {
        if (value === undefined || HOP.has(key)) continue
        // A redirect to the app's root (`Location: /…`) must stay under the prefix.
        if (key === 'location' && target.strip && typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) {
          headers[key] = `${target.prefix}${value}`
          continue
        }
        headers[key] = value
      }
      res.writeHead(answer.statusCode ?? 502, headers)
      // Server-sent events: every chunk goes out at once.
      res.flushHeaders()
      answer.pipe(res)
      answer.on('end', () => { resolve() })
      answer.on('error', () => { res.destroy(); resolve() })
    })
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(unreachablePage(req, target.name, address, error.message))
      } else {
        res.destroy()
      }
      resolve()
    })
    // The browser went away (closed tab, aborted SSE): stop the app's answer too.
    res.on('close', () => { if (!res.writableFinished) upstream.destroy() })
    req.pipe(upstream)
  })
  return { kind: 'prefix', path: target.prefix, handler }
}
