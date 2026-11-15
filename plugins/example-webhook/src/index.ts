/**
 * Example webhook: the smallest useful plugin, and the template to copy.
 *
 * It listens to the studio's notices (`ctx.onNotify` — a scheduled
 * publication that failed, anything another plugin wants the owner to know)
 * and POSTs each one to an address, as `{ "text": "…" }`. It also answers a
 * "send a test" action, so the settings page can prove the address works
 * before anything real goes out.
 *
 * Read `docs/plugin-api.md` beside this file: every part of the contract it
 * uses is the whole contract a plugin needs for a job like this one.
 * @module example-webhook
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PluginContext, PluginSetup } from '../../../server/src/plugins.ts'

/** How long the address has to accept one POST. */
const TIMEOUT_MS = 5_000

/** A notice longer than this is cut: a webhook should not receive a novel. */
const MAX_TEXT = 2_000

/** What one send came to; never throws, so a dead address cannot break a tick. */
type Sent = { readonly ok: true } | { readonly ok: false; readonly error: string }

/**
 * The plugin's entry point. `setup` runs once, when the host loads the plugin;
 * what it returns is the rest of the contract (routes, status, and a tick if
 * the plugin had one).
 * @param ctx - what the host gives the plugin: its id, its folders, its
 *   settings and the studio's clients.
 * @returns the routes and the status line.
 */
export default function setup(ctx: PluginContext): PluginSetup {
  /** One setting as a trimmed string. Read it here, never at module load: the
   *  page can save new values while the plugin runs, and `config()` gives the
   *  ones in force at the moment of the call. */
  const setting = (key: string): string => String(ctx.config()[key] ?? '').trim()

  /** Whether there is an address to send to at all. */
  const configured = (): boolean => setting('url') !== ''

  /** The host of the address, for the status line: the path could carry a
   *  token, so it is not shown. */
  const hostOf = (url: string): string => {
    try {
      return new URL(url).host
    } catch {
      return '(unreadable address)'
    }
  }

  /**
   * POST one text to the address.
   * @param text - the notice.
   * @returns what happened; the caller decides whether to log or answer 502.
   */
  const post = async (text: string): Promise<Sent> => {
    const url = setting('url')
    if (url === '') return { ok: false, error: 'no address configured' }
    const secret = setting('secret')
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The secret is a header, not part of the body: it stays out of
          // whatever the receiving end might log as content.
          ...secret === '' ? {} : { 'x-webhook-secret': secret },
        },
        body: JSON.stringify({ text: text.slice(0, MAX_TEXT) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      return response.ok
        ? { ok: true }
        : { ok: false, error: `the address answered HTTP ${String(response.status)}` }
    } catch (error: unknown) {
      // A refused connection, a DNS failure, a timeout: all of them are one
      // thing to the studio — the notice did not go out — and none of them may
      // escape into the host's notice loop.
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // Subscribe to the notices. The subscription goes away with the plugin
  // (a reload removes it, like its routes), so there is nothing to clean up.
  ctx.onNotify(async (text) => {
    if (ctx.config().enabled !== true) return
    const sent = await post(text)
    ctx.log(sent.ok ? 'notice forwarded' : `notice not sent: ${sent.error}`)
  })

  return {
    routes: [
      {
        // An action of the manifest points here: POST /plugin/example-webhook/test.
        // The path must stay under /plugin/<id>/ — the host refuses anything else.
        path: '/plugin/example-webhook/test',
        kind: 'exact',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          req.resume()
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end(JSON.stringify({ ok: false, error: 'POST only' }))
            return
          }
          if (!configured()) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: 'no address configured' }))
            return
          }
          const sent = await post('Example webhook: this is a test from the studio.')
          res.statusCode = sent.ok ? 200 : 502
          res.end(JSON.stringify(sent))
        },
      },
    ],
    // The panel asks for this every time the settings page opens, and has two
    // seconds: nothing here goes to the network.
    status: () => ({
      ok: configured(),
      summary: configured() ? `→ ${hostOf(setting('url'))}` : 'no address yet',
      detail: ctx.config().enabled === true ? 'forwarding the notices' : 'not forwarding: the toggle is off',
    }),
  }
}
