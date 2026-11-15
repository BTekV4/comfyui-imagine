/**
 * The studio's number and clock formats, in one place: two-digit padding, the
 * wall clock (hh:mm), a clip position (m:ss, with decimals where a cut or a
 * frame needs them) and the value a datetime-local input reads.
 *
 * Written by hand rather than with `toLocaleString`, which follows the
 * browser's language and not the page's (see `dates.ts`).
 * @module format
 */

/**
 * A number as two digits (`7` → `07`).
 * @param value - a whole number from 0 to 99.
 * @returns the padded text.
 */
export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * A wall clock for a chat line or a calendar chip: 24-hour hh:mm.
 * @param at - epoch milliseconds.
 * @returns the time as hh:mm.
 */
export function clockStamp(at: number): string {
  const d = new Date(at)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * The time a run has left, as the tile says it: rounded up to five seconds so
 * a label redrawn every second does not flicker, `40 s` under a minute and
 * `1:35` above it.
 * @param seconds - the estimate, in seconds.
 * @returns the text, without the `~` the label puts in front.
 */
export function formatEta(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const rounded = Math.max(5, Math.ceil(safe / 5) * 5)
  if (rounded < 60) return `${String(rounded)} s`
  return formatClock(rounded)
}

/**
 * How long a run took, for the details card: minutes and seconds, or hours
 * for the long montages.
 * @param ms - the run's wall clock, in milliseconds.
 * @returns the text (`12 s`, `4 min 05 s`, `1 h 12 min`).
 */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0
  if (total < 60) return `${String(total)} s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${String(minutes)} min ${pad2(total % 60)} s`
  return `${String(Math.floor(minutes / 60))} h ${pad2(minutes % 60)} min`
}

/**
 * A clip position as m:ss (`1:04`, `12:30`), or m:ss.cc / m:ss.mmm when the
 * caller places something to the hundredth or the thousandth of a second.
 * @param seconds - the position, in seconds.
 * @param decimals - digits after the seconds' point; 0 rounds to the second.
 * @returns the clock text; zero for a non-finite input.
 */
export function formatClock(seconds: number, decimals = 0): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  if (decimals === 0) {
    const total = Math.round(safe)
    return `${String(Math.floor(total / 60))}:${pad2(total % 60)}`
  }
  const minutes = Math.floor(safe / 60)
  return `${String(minutes)}:${(safe - minutes * 60).toFixed(decimals).padStart(decimals + 3, '0')}`
}

/**
 * Turn an ISO instant into the value a datetime-local input wants, in the
 * viewer's own zone — `toISOString` would shift it by the offset and move a
 * scheduled post by hours.
 * @param iso - the stored instant.
 * @returns the "YYYY-MM-DDTHH:MM" the input reads, or undefined for no usable date.
 */
export function localInputValue(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return undefined
  return `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}
