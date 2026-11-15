/**
 * Restart Imagine and wait for it to answer again: the settings page's
 * "Apply" and the host's "Restart Imagine" each had a copy, with different limits
 * (60 and 30 tries).
 * @module client/imagine-restart
 */

import { getJson, send } from './http.ts'

/** How long a restart is waited for: one health check a second. */
const RESTART_TRIES = 60

/**
 * Ask the host to restart, then poll `/api/health` once a second.
 * @returns true once the host answers, false when it did not come back in time.
 */
export async function restartImagine(): Promise<boolean> {
  await send<{ ok: boolean }>('/api/restart', 'POST', undefined, 'HTTP')
  for (let i = 0; i < RESTART_TRIES; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    try {
      await getJson<{ ok: boolean }>('/api/health', 'HTTP')
      return true
    } catch { /* still coming back */ }
  }
  return false
}
