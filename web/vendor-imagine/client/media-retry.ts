/**
 * Ask for a still again after a load that failed, and say when it is worth
 * asking: every media bed in the studio is `#111`, so one failed request —
 * the second the server is restarted, a dropped Wi-Fi, a tab left open
 * across a deploy — leaves a black rectangle that no re-render ever repairs.
 * @module media-retry
 */

/**
 * How long to wait before each retry of a still that failed to load. The
 * length of this list is also how many retries one still gets: the first is
 * fast because most failures are a single request landing in a restart, and
 * the last is far enough out to clear a service that takes a few seconds to
 * come back.
 */
export const RETRY_DELAYS: readonly number[] = [400, 1500, 4000]

/**
 * The URL for one attempt. The first attempt is the URL untouched, so the
 * browser cache and the `?v=<mtime>` validator still do their work; a retry
 * carries a counter, because a request the browser already failed is not
 * repeated for the same URL.
 * @param url - the media URL, query string and all.
 * @param attempt - 0 for the first load, then one per retry.
 * @returns the URL to request.
 */
export function attemptSrc(url: string, attempt: number): string {
  if (attempt <= 0) return url
  return `${url}${url.includes('?') ? '&' : '?'}retry=${String(attempt)}`
}

let epoch = 0
const listeners = new Set<() => void>()
let armed = false

/**
 * A counter that rises whenever the browser has reason to believe media that
 * failed could load now: the network came back, or the tab did.
 * @returns the current epoch.
 */
export function mediaEpoch(): number {
  return epoch
}

/** Raise the epoch, waking every still that gave up. */
function bumpMediaEpoch(): void {
  epoch += 1
  for (const listener of listeners) listener()
}

/**
 * Subscribe to the epoch. One pair of window listeners serves every still on
 * the page, however many tiles the canvas is holding.
 * @param listener - called when the epoch rises.
 * @returns the unsubscribe function.
 */
export function subscribeMediaEpoch(listener: () => void): () => void {
  listeners.add(listener)
  if (!armed) {
    armed = true
    // Read through a partial window: this module is imported by tests that run
    // without a DOM, where neither of these exists.
    const view = globalThis as unknown as Partial<Window>
    view.addEventListener?.('online', bumpMediaEpoch)
    const page = view.document
    page?.addEventListener('visibilitychange', () => {
      if (page.visibilityState === 'visible') bumpMediaEpoch()
    })
  }
  return () => { listeners.delete(listener) }
}
