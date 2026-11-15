/**
 * Which "choose" blocks the user closed, per browser.
 *
 * The block offering a scan's candidates is derived from the jobs, not kept in
 * the page: that is what makes a choice survive a reload. It also means a
 * dismissed choice would come straight back on the next render or reload —
 * right for a choice still to be made, wrong for one the user has said no to.
 *
 * So the answer lives here, in localStorage like the model chip and the media
 * page's view: it is a preference of this browser, not something the project
 * should carry. Entries expire like the scans themselves (a scan leaves the
 * queue after a day), so the map cannot grow for ever.
 * @module dismissed-scans
 */

/** The key the map is stored under. */
const KEY = 'imagine.dismissedScans'

/** How long a dismissal is honoured. Longer than a scan's own 24 h, and bounded. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000

/** How many dismissals are kept: past this the oldest are dropped. */
const KEEP = 40

/**
 * The scans whose choice block was closed in this browser.
 * @returns scan job id → when it was closed, oldest entries already dropped.
 */
export function readDismissedScans(): Readonly<Record<string, number>> {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const now = Date.now()
    const kept: Record<string, number> = {}
    for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof at !== 'number' || !Number.isFinite(at)) continue
      if (now - at > TTL_MS) continue
      kept[id] = at
    }
    return kept
  } catch {
    // Private mode, or a value something else wrote: nothing is dismissed,
    // which shows the block again rather than breaking the column.
    return {}
  }
}

/**
 * Remember that one block was closed.
 * @param id - the scan job whose block was dismissed.
 * @returns the whole map, as written.
 */
export function rememberDismissedScan(id: string): Readonly<Record<string, number>> {
  const merged = { ...readDismissedScans(), [id]: Date.now() }
  const trimmed = Object.fromEntries(
    Object.entries(merged).sort((left, right) => right[1] - left[1]).slice(0, KEEP),
  )
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(trimmed))
  } catch {
    // The choice is simply not remembered: the block comes back next time.
  }
  return trimmed
}
