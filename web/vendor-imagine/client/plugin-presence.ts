/**
 * Which plugins the host has installed and switched on, as the studio asks
 * once and caches.
 *
 * The page carries UI that belongs to a plugin (the Instagram queue, its
 * rail entry, "Publish to Instagram"), and the base studio has no social side:
 * that UI is shown only while the plugin is there. The answer comes from the
 * same list the Plugins page draws (GET /comfy-plugins), read once per page
 * load; the Plugins page hands every list it reads back here, so switching a
 * plugin on or off there reaches the studio without a reload.
 * @module plugin-presence
 */

import { useSyncExternalStore } from 'react'
import { getJson } from './http.ts'

/** The id the Instagram plugin is installed under. */
export const INSTAGRAM_PLUGIN = 'instagram'

/** The plugins that bring an app into the rail (2026-11-15), by the view that shows it. */
export const APP_PLUGINS = { openjutsu: 'openjutsu', iopaint: 'iopaint' } as const

/** The id of the IOPaint plugin, which also does «Rimuovi oggetto». */
export const IOPAINT_PLUGIN = APP_PLUGINS.iopaint

/** What this module reads of one row of the plugin list. */
export interface PluginPresence {
  readonly id: string
  readonly installed: boolean
  readonly enabled: boolean
}

/** Ids installed and enabled; undefined until the host has answered. */
let present: ReadonlySet<string> | undefined
let asking = false
const listeners = new Set<() => void>()

/**
 * Record the plugin list the host answered (by this module or by the Plugins page).
 * @param list - the `plugins` rows of GET /comfy-plugins.
 */
export function notePlugins(list: readonly PluginPresence[]): void {
  const next = new Set(list.filter(plugin => plugin.installed && plugin.enabled).map(plugin => plugin.id))
  const known = present
  if (known !== undefined && known.size === next.size && [...next].every(id => known.has(id))) return
  present = next
  for (const listener of listeners) listener()
}

/** Ask the host for the list, once; a failure leaves the answer unknown and lets a later reader ask again. */
function ask(): void {
  if (present !== undefined || asking) return
  asking = true
  getJson<{ plugins?: PluginPresence[] }>('/comfy-plugins', 'plugins')
    .then((body) => { if (Array.isArray(body.plugins)) notePlugins(body.plugins) })
    .catch(() => { /* unknown stays unknown: the page keeps showing what it shows */ })
    .finally(() => { asking = false })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  ask()
  return () => { listeners.delete(listener) }
}

/**
 * Whether a plugin is installed and enabled, as last known.
 * @param id - the plugin's id.
 * @returns true or false, or undefined while the host has not answered.
 */
export function pluginEnabled(id: string): boolean | undefined {
  return present === undefined ? undefined : present.has(id)
}

/**
 * `pluginEnabled`, re-rendering when the answer arrives or changes.
 * @param id - the plugin's id.
 * @returns true or false, or undefined while the host has not answered.
 */
export function usePluginEnabled(id: string): boolean | undefined {
  return useSyncExternalStore(subscribe, () => pluginEnabled(id))
}
