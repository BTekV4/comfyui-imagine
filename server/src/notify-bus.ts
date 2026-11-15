/**
 * The host's notice bus: something wants the owner told, and every plugin that
 * asked for notices hears it.
 *
 * The studio had one notifier and one caller — the Instagram publisher called a
 * function the Telegram module had built, and the two were wired together in
 * `main.ts`. Once both are plugins that wiring cannot exist: the publisher does
 * not know who is listening, and Telegram does not know who is talking. So the
 * host owns a list, `notify` feeds it and `onNotify` subscribes to it.
 *
 * Two rules, both learned the hard way with the old single notifier:
 * - a handler that throws or hangs is logged and skipped: a failing Telegram
 *   must not turn a failed publication into a failed scheduler tick;
 * - a plugin's own notice never comes back to the plugin that sent it, or a
 *   plugin that both sends and listens would answer itself forever.
 * @module notify-bus
 */

/**
 * Wait for at most `ms`.
 *
 * The one timeout race of the host: the bus bounds each subscriber with it,
 * and the plugins system each plugin's status (it had its own copy until
 * 2026-11-15). The work is not cancelled, only no longer waited for.
 * @param work - the promise or value.
 * @param ms - the budget.
 * @returns the value, or undefined when the budget ran out.
 */
export async function within<T>(work: Promise<T> | T, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<undefined>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(undefined), ms) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * What may travel with a notice besides its text: one picture, as a file on
 * this machine or as a public address. A listener that cannot show pictures
 * ignores it — the text alone must always make sense.
 */
export interface NotifyExtra {
  /** A JPEG or PNG on this machine; it exists until the notice resolves. */
  readonly photoPath?: string
  /** A picture anyone can download (a Meta CDN address, for instance). */
  readonly photoUrl?: string
}

/** What a subscriber is: one function, possibly async. */
export type NotifyHandler = (text: string, extra?: NotifyExtra) => void | Promise<void>

/** One subscriber, with the plugin it belongs to (absent for the host's own). */
interface Entry {
  readonly owner: string | undefined
  readonly handler: NotifyHandler
}

/** The bus, as `main.ts` and the plugin loader use it. */
export interface NotifyBus {
  /**
   * Hand `text` to every subscriber.
   * @param text - the notice.
   * @param from - the plugin sending it, skipped among the subscribers.
   * @param extra - a picture to show with it, for the listeners that can.
   * @returns when every subscriber has answered or its time is up; never rejects.
   */
  notify(text: string, from?: string, extra?: NotifyExtra): Promise<void>
  /**
   * Subscribe to the notices.
   * @param handler - what to do with one notice.
   * @param owner - the plugin it belongs to, for the skip rule and the log.
   * @returns the function that removes the subscription.
   */
  onNotify(handler: NotifyHandler, owner?: string): () => void
  /** How many subscribers there are now. */
  readonly size: number
}

/** How long one subscriber has before the bus gives up on it. */
export const NOTIFY_TIMEOUT_MS = 10_000

/** How one subscriber ended. */
type Outcome = { readonly kind: 'ok' } | { readonly kind: 'error'; readonly error: unknown } | { readonly kind: 'timeout' }

/**
 * Create a bus.
 * @param options.timeoutMs - how long one subscriber has; 10 s by default.
 * @returns the bus.
 */
export function createNotifyBus(options: { readonly timeoutMs?: number } = {}): NotifyBus {
  const timeoutMs = options.timeoutMs ?? NOTIFY_TIMEOUT_MS
  const entries: Entry[] = []
  return {
    get size() { return entries.length },
    onNotify(handler, owner) {
      const entry: Entry = { owner, handler }
      entries.push(entry)
      return () => {
        const at = entries.indexOf(entry)
        if (at >= 0) entries.splice(at, 1)
      }
    },
    async notify(text, from, extra) {
      // A snapshot: a handler that subscribes or leaves while the notices go
      // out must not change the list this notice is being delivered to.
      // Every subscriber at once: a slow one (up to the timeout) must not hold
      // back the others. Each has its own race and its own log line, so one
      // failing still leaves the others delivered.
      const deliver = async (entry: Entry): Promise<void> => {
        const who = entry.owner ?? 'handler'
        const outcome: Outcome = await within(
          Promise.resolve()
            .then(() => entry.handler(text, extra))
            .then(() => ({ kind: 'ok' }) as Outcome, (error: unknown) => ({ kind: 'error', error }) as Outcome),
          timeoutMs,
        ) ?? { kind: 'timeout' }
        if (outcome.kind === 'error') {
          console.warn(`[notify] ${who} failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`)
        } else if (outcome.kind === 'timeout') {
          console.warn(`[notify] ${who} did not answer within ${String(Math.round(timeoutMs / 1000))} s`)
        }
      }
      await Promise.allSettled(entries
        .filter(entry => from === undefined || entry.owner !== from)
        .map(deliver))
    },
  }
}
