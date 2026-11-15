/**
 * IOPaint inside the studio (a plugin since 2026-11-15; before, the host
 * called it itself).
 *
 * Two things: «Rimuovi oggetto» on photos (`/plugin/iopaint/erase`, see
 * `erase.ts`), and IOPaint's own page, passed through under `/apps/iopaint`
 * behind Imagine's login. IOPaint answers at its root, and its built frontend
 * is patched to call `/apps/iopaint/…`: the pass drops the prefix on the way
 * in. Without the plugin the studio offers neither (`plugin-presence.ts`).
 * @module iopaint
 */
import { createAppProxyRoute } from '../../../server/src/app-proxy.ts'
import { probeApp } from '../../../server/src/app-probe.ts'
import type { PluginContext, PluginSetup } from '../../../server/src/plugins.ts'
import { createEraseRoute } from './erase.ts'

const DEFAULT_URL = 'http://127.0.0.1:8080'

/**
 * The plugin's entry point.
 * @param ctx - the host's context.
 * @returns the erase route, the pass-through route and the status.
 */
export default function setup(ctx: PluginContext): PluginSetup {
  const url = (): string => String(ctx.config()['url'] ?? '').trim() || DEFAULT_URL
  const proxy = createAppProxyRoute({ name: 'IOPaint', prefix: '/apps/iopaint', url, strip: true })
  return {
    routes: [
      { path: '/plugin/iopaint/erase', kind: 'exact', handler: createEraseRoute(ctx.mediaDir, url) },
      { path: proxy.path, kind: 'prefix', handler: proxy.handler },
    ],
    async status() {
      const probe = await probeApp(url())
      return probe.ok
        ? { ok: true, summary: { en: `answers at ${url()}`, it: `risponde su ${url()}` } }
        : { ok: false, summary: { en: `${url()} does not answer`, it: `${url()} non risponde` }, detail: probe.error }
    },
  }
}
