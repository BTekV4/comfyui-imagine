/**
 * The fake host the plugin tests hand to `createPlugins`: no ComfyUI, no
 * model clients, a real notice bus and a list of the registered routes.
 *
 * Five test files carried their own copy until 2026-11-14.
 * @module test/helpers/plugin-host
 */
import { createNotifyBus, type NotifyBus } from '../../server/src/notify-bus.ts'
import type { PluginsOptions } from '../../server/src/plugins.ts'
import type { WebRoute } from '../../server/src/host.ts'
import type { ModelRoute } from '../../shared/imagine-types.ts'

/** The host half, the bus behind it and the routes the plugins registered. */
export interface FakePluginHost {
  readonly host: PluginsOptions['host']
  readonly bus: NotifyBus
  /** The routes registered and not yet removed, handler included. */
  readonly routes: WebRoute[]
}

/**
 * A fake host.
 * @param options.mediaDir - what the plugins see as the gallery folder.
 * @param options.model - the model the page names; `test/test` by default.
 * @param options.notifyTimeoutMs - how long a listener has; 500 ms by default.
 * @returns the host and what it collects.
 */
export function fakePluginHost(options: {
  readonly mediaDir: string
  readonly model?: ModelRoute
  readonly notifyTimeoutMs?: number
}): FakePluginHost {
  const routes: WebRoute[] = []
  const bus = createNotifyBus({ timeoutMs: options.notifyTimeoutMs ?? 500 })
  const model = options.model ?? { provider: 'test', model: 'test' }
  return {
    bus,
    routes,
    host: {
      comfy: {} as never,
      llm: {} as never,
      auxiliary: {} as never,
      model: () => model,
      mediaDir: options.mediaDir,
      notify: (text, from, extra) => bus.notify(text, from, extra),
      onNotify: (handler, owner) => bus.onNotify(handler, owner),
      register: (route) => {
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at >= 0) routes.splice(at, 1)
        }
      },
    },
  }
}
