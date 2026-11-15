/**
 * The studio's timers: an interval that sleeps while the tab is hidden, a
 * read kept fresh on it, and a running count of seconds.
 *
 * The studio polled on fixed timers even in a background tab: every panel
 * kept fetching for a page nobody was looking at. The interval here stops when
 * the document is hidden and, on coming back, runs once at once and resumes.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * Run `callback` every `ms` while the tab is visible.
 *
 * A callback that returns a promise is not called again until that promise
 * settles: a plain `setInterval` fired the next request while the last one
 * was still out, so on a slow host two reads of the same route overlapped and
 * the older answer could land last.
 * @param callback - the work; always the latest one passed, so it may close over fresh state.
 * @param ms - the period, or null to stop.
 */
export function useVisibleInterval(callback: () => void | Promise<unknown>, ms: number | null): void {
  const latest = useRef(callback)
  latest.current = callback
  /*
   * Whether the last call is still running. A ref, not a variable of the
   * effect: a change of `ms` restarts the timer while a call may be out, and
   * the new timer must still wait for it.
   */
  const running = useRef(false)
  useEffect(() => {
    if (ms === null) return
    let handle: ReturnType<typeof setInterval> | undefined
    const fire = (): void => {
      if (running.current) return
      const result = latest.current()
      if (result instanceof Promise) {
        running.current = true
        const done = (): void => { running.current = false }
        result.then(done, done)
      }
    }
    const start = (): void => {
      if (handle === undefined) handle = setInterval(fire, ms)
    }
    const stop = (): void => {
      if (handle !== undefined) clearInterval(handle)
      handle = undefined
    }
    const onVisibility = (): void => {
      if (document.hidden) {
        stop()
      } else {
        fire()
        start()
      }
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [ms])
}

/**
 * A read made once on mount and again every `ms` while the tab is visible:
 * the social panels' lists, which the host changes on its own clock.
 *
 * A failed read leaves the data as it was: the host keeps working from its
 * own copy either way, and an empty list would read as "nothing queued".
 * @param read - the request; always the latest one passed.
 * @param ms - the period, or null for the one read on mount.
 * @returns the last answer (undefined until the first), whether a first read
 *   has finished (answered or not), a way to read again now, and a setter for
 *   a row the page changed itself (a like, a move) before the next read.
 */
export function usePolled<T>(read: () => Promise<T>, ms: number | null): {
  readonly data: T | undefined
  readonly loaded: boolean
  readonly reload: () => Promise<void>
  readonly update: Dispatch<SetStateAction<T | undefined>>
} {
  const [data, setData] = useState<T>()
  const [loaded, setLoaded] = useState(false)
  const latest = useRef(read)
  latest.current = read
  const reload = useCallback(async (): Promise<void> => {
    try {
      setData(await latest.current())
    } catch {
      // Kept as it was; see above.
    } finally {
      setLoaded(true)
    }
  }, [])
  useEffect(() => { void reload() }, [reload])
  // Handed the promise, so a slow read is not started again on top of itself.
  useVisibleInterval(reload, ms)
  return { data, loaded, reload, update: setData }
}

/**
 * Whole seconds since `running` turned true, ticking once a second; 0 while
 * it is false. For the clocks on a wait the user would otherwise read as stuck.
 * @param running - whether the wait is on.
 * @returns the seconds waited so far.
 */
export function useElapsedSeconds(running: boolean): number {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!running) return
    setSeconds(0)
    const started = Date.now()
    const timer = setInterval(() => { setSeconds(Math.round((Date.now() - started) / 1000)) }, 1000)
    return () => { clearInterval(timer) }
  }, [running])
  return seconds
}
