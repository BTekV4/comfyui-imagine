/**
 * Whether a web app answers, for the status line of the plugins that pass one
 * through (plugins/openjutsu, plugins/iopaint). Any HTTP answer counts: the app
 * is up, even when its root is a redirect or a 404.
 * @module app-probe
 */

/** What the probe found: up, or the reason it is not. */
export type AppProbe = { readonly ok: true } | { readonly ok: false; readonly error: string }

/**
 * Ask the app's address once, within a budget that fits the plugins page's
 * two seconds for a status.
 * @param url - the app's address.
 * @param ms - the budget.
 * @returns whether it answered.
 */
export async function probeApp(url: string, ms = 1_500): Promise<AppProbe> {
  try {
    const answer = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(ms) })
    await answer.body?.cancel().catch(() => undefined)
    return { ok: true }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
