/**
 * Openjutsu inside the studio (a plugin since 2026-11-15; before, the host
 * mounted it itself).
 *
 * The app is a Next.js server of its own, built with
 * `basePath: "/apps/openjutsu"`: the plugin passes `/apps/openjutsu/…` through
 * to it, behind Imagine's login, and the page shows it in the rail while the
 * plugin is installed and on (`plugin-presence.ts`, `AppFrame.tsx`).
 * @module openjutsu
 */
import { createAppProxyRoute } from '../../../server/src/app-proxy.ts'
import { probeApp } from '../../../server/src/app-probe.ts'
import type { PluginContext, PluginSetup } from '../../../server/src/plugins.ts'

const DEFAULT_URL = 'http://127.0.0.1:3000'

/**
 * The plugin's entry point.
 * @param ctx - the host's context.
 * @returns the pass-through route and the status.
 */
export default function setup(ctx: PluginContext): PluginSetup {
  const url = (): string => String(ctx.config()['url'] ?? '').trim() || DEFAULT_URL
  const proxy = createAppProxyRoute({ name: 'Openjutsu', prefix: '/apps/openjutsu', url, strip: false })
  return {
    routes: [{ path: proxy.path, kind: 'prefix', handler: proxy.handler }],
    async status() {
      const probe = await probeApp(url())
      return probe.ok
        ? { ok: true, summary: { en: `answers at ${url()}`, it: `risponde su ${url()}` } }
        : { ok: false, summary: { en: `${url()} does not answer`, it: `${url()} non risponde` }, detail: probe.error }
    },
  }
}
