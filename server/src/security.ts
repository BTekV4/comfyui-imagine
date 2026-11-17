/**
 * Cross-site request checks and the headers every answer carries.
 *
 * A browser is told to send `Origin` on every state-changing request. When it
 * does, the request is accepted only if that origin is the studio's own; when
 * it sends none, there was no cross-site browser involved (curl, the MCP
 * server, a plugin's webhook, the Electron window's own page) and the request
 * goes on. `Referer` is the fallback for the few browsers that still omit
 * `Origin`, and `Sec-Fetch-Site` covers a browser that omits both.
 *
 * Behind a reverse proxy the public name arrives in `X-Forwarded-Host` while
 * `Host` is the app's internal address; either one is accepted, because a
 * browser cannot forge a forbidden header and the alternative would refuse
 * every same-origin POST behind a proxy.
 *
 * The headers below are the baseline the studio never had: no MIME sniffing, a
 * referrer that does not leak the page's address, no framing by another site,
 * and a Content Security Policy narrow enough for the page as it is built.
 * @module security
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Methods that change state and therefore need an origin check. */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** One header value: Node gives a list when the client sent the same header twice. */
const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value

/** A `scheme://host[:port]` value, as an origin or a referer spells it. */
function authorityOf(raw: string): { readonly host: string; readonly port: string } | undefined {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return { host: url.hostname.toLowerCase(), port: url.port }
  } catch {
    return undefined
  }
}

/** A `Host` header value, which has no scheme. */
function hostOf(raw: string): { readonly host: string; readonly port: string } | undefined {
  const value = raw.trim()
  if (value === '') return undefined
  try {
    const url = new URL(`http://${value}`)
    return { host: url.hostname.toLowerCase(), port: url.port }
  } catch {
    return undefined
  }
}

/** The names this request may legitimately have been addressed to. */
function targetHosts(req: Pick<IncomingMessage, 'headers'>): string[] {
  const forwarded = first(req.headers['x-forwarded-host'])
  const list = forwarded === undefined ? [] : forwarded.split(',').map(part => part.trim()).filter(part => part !== '')
  const host = first(req.headers.host)
  if (host !== undefined && host.trim() !== '') list.push(host)
  return list
}

/**
 * Whether an origin belongs to the studio this request reached.
 * @param origin - the `Origin` or `Referer` value.
 * @param hosts - the `Host`/`X-Forwarded-Host` values of the request.
 */
function sameOrigin(origin: string, hosts: readonly string[]): boolean {
  const from = authorityOf(origin)
  if (from === undefined) return false
  return hosts.some((raw) => {
    const to = hostOf(raw)
    if (to === undefined) return false
    // The port is compared as written: both empty on the default one, both
    // equal on a LAN address, and a different explicit port is another origin.
    return from.host === to.host && from.port === to.port
  })
}

/**
 * Whether a state-changing request may proceed.
 *
 * A request with no browser origin at all is not a cross-site request: it is
 * curl, the MCP server, a plugin's webhook or a probe, and it passes. A browser
 * that sends `Sec-Fetch-Site: cross-site` (or `same-site`, which is still a
 * different origin) without an origin is refused.
 * @param req - the request, for its method and headers.
 * @returns true when the request is not state-changing, or comes from the studio.
 */
export function stateChangeAllowed(req: Pick<IncomingMessage, 'method' | 'headers'>): boolean {
  if (!STATE_CHANGING.has((req.method ?? 'GET').toUpperCase())) return true
  const hosts = targetHosts(req)
  const origin = first(req.headers.origin)
  if (origin !== undefined) return sameOrigin(origin, hosts)
  const referer = first(req.headers.referer)
  if (referer !== undefined) return sameOrigin(referer, hosts)
  const site = first(req.headers['sec-fetch-site'])
  return site !== 'cross-site' && site !== 'same-site'
}

/**
 * The Content Security Policy for the studio's own pages.
 *
 * `'unsafe-inline'` in `style-src` is needed: the page sets inline `style`
 * attributes (the dragged chat width, a cover's colour) that a stricter policy
 * drops, and there is no script inline anywhere. `connect-src` stays on the
 * studio alone: the chat, the jobs and the gallery all talk to the same origin
 * (server-sent events included), and the page opens no WebSocket of its own.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ')

/**
 * Put the baseline headers on an answer before its handler writes it.
 *
 * The proxied app pages (`/apps/…`) get no CSP: they are other programs with
 * their own inline scripts, and their own headers, if any, win anyway. The
 * rest of the studio, JSON answers included, gets the policy.
 * @param res - the response.
 * @param path - the request's pathname.
 */
export function applySecurityHeaders(res: ServerResponse, path: string): void {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin')
  res.setHeader('x-frame-options', 'SAMEORIGIN')
  if (!path.startsWith('/apps/')) res.setHeader('content-security-policy', CONTENT_SECURITY_POLICY)
}
