/**
 * The owner's clock: what day and hour it is in Rome.
 *
 * The notices that run "once a day" or "on Sunday evening" are about the
 * owner's day, not the container's: the box may run in UTC, the owner does not.
 * @module social/clock
 */

/** The parts of a moment the notices read. */
export interface RomeClock {
  /** `2026-11-14`. */
  readonly day: string
  /** 0–23. */
  readonly hour: number
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekday: number
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const format = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Rome',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
})

/**
 * The day, hour and weekday of a moment in Rome.
 * @param at - the moment.
 * @returns its parts.
 */
export function romeClock(at: Date): RomeClock {
  const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]))
  return {
    day: `${parts['year'] ?? ''}-${parts['month'] ?? ''}-${parts['day'] ?? ''}`,
    hour: Number(parts['hour'] ?? 0),
    weekday: Math.max(0, WEEKDAYS.indexOf(parts['weekday'] ?? '')),
  }
}
