/**
 * Whether the owner hid the warning about a studio open to the network.
 *
 * The choice belongs to the studio, not to one browser: it is kept in
 * `<data>/access-banner.json` (0600, written atomically) and every device
 * reads it through `/api/access`. Kept in the browser instead, hiding the
 * strip would hide it only where it was clicked.
 *
 * The dismissal is tied to the situation that produced it, because the strip
 * exists only while the studio is open: the file records the address the
 * studio listens on. A different `host:` shows the strip again, and
 * {@link forgetDismissalWhenLoginMoves} forgets it when the login switch is
 * turned on or off: a studio that was closed for a while must warn again once
 * it is open.
 * @module access-banner
 */

import { rm } from 'node:fs/promises'
import { readJsonFile, serialized, writeFileAtomic } from '../vendor/atomic-write/index.ts'

/** The dismissal as it is kept on disk. */
interface StoredBanner {
  /** The listening address the warning was hidden for. */
  readonly host: string
}

/** The studio-wide memory of a hidden warning. */
export interface AccessBanner {
  /** The listening address the warning was hidden for, or undefined. */
  hiddenFor(): string | undefined
  /** Hide the warning for `host` on every device. */
  hide(host: string): Promise<void>
  /** Show the warning again on every device. */
  show(): Promise<void>
}

/**
 * Read the dismissal, or start from none.
 * @param file - `<data>/access-banner.json`.
 * @returns the store.
 */
export async function createAccessBanner(file: string): Promise<AccessBanner> {
  const read = await readJsonFile(file, '[imagine]')
  const stored = typeof read === 'object' && read !== null && !Array.isArray(read) ? read as Partial<StoredBanner> : {}
  let host = typeof stored.host === 'string' && stored.host !== '' ? stored.host : undefined
  /** Write, or remove, the file one writer at a time. */
  const write = (next: string | undefined): Promise<void> => serialized(file, async () => {
    if (next === undefined) {
      await rm(file, { force: true })
    } else {
      await writeFileAtomic(file, `${JSON.stringify({ host: next }, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    }
    host = next
  })
  return {
    hiddenFor: () => host,
    hide: (value) => write(value),
    show: () => write(undefined),
  }
}

/**
 * Forget the dismissal when the login switch moved.
 *
 * The strip says the studio is open. A warning hidden while it was open must
 * come back once the login has been turned on and then off again: the studio
 * really was closed in between. Either move counts, on or off, because the
 * switch coming on already ends the situation the dismissal described.
 * @param banner - the store.
 * @param before - `requireLogin` before the save.
 * @param after - `requireLogin` as the save left it.
 */
export async function forgetDismissalWhenLoginMoves(banner: AccessBanner, before: boolean, after: boolean): Promise<void> {
  if (before !== after) await banner.show()
}
