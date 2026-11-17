/**
 * Stop when the app that started us is gone.
 *
 * A studio started from the desktop app has an owner: the window. Closing the
 * window is not the only way to lose it — a logout, a `kill`, a crash of the
 * window's process — and a server that outlives its window keeps the port, the
 * settings and whatever job was running for nobody. The app passes its pid in
 * `IMAGINE_PARENT_PID`; this watches it.
 *
 * Why the app cannot do it from its side: on Linux the browser process handles
 * `SIGTERM` itself and exits without running the Node handlers, so there is no
 * moment in the app to kill the child. On Windows a killed parent leaves a
 * child exactly the same way. The child watching the parent is what works on
 * both.
 *
 * Nothing happens without the variable: a service, a container or a portable
 * package has no parent to watch and behaves as it always did.
 * @module parent-watch
 */

/**
 * Whether the parent is gone.
 *
 * Two signs, either enough: the process was re-parented (POSIX), or the pid no
 * longer answers (both platforms).
 * @param parentPid - the pid the app passed.
 * @param currentPpid - `process.ppid` now.
 * @param alive - asks the system whether a pid exists.
 * @returns true when the studio should stop.
 */
export function parentGone(
  parentPid: number,
  currentPpid: number,
  alive: (pid: number) => boolean,
): boolean {
  return currentPpid !== parentPid || !alive(parentPid)
}

/** How often the parent is looked for. */
export const CHECK_INTERVAL_MS = 2_000

/**
 * Is that pid still there?
 * @param pid - the pid to ask about.
 * @returns false only when the system says it does not exist.
 */
function alive(pid: number): boolean {
  try {
    // Signal 0 asks the question without touching the process. EPERM means it
    // exists and belongs to somebody else: alive.
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Watch the app, and call `onGone` once when it disappears.
 *
 * The interval is `unref`d: it never keeps the studio alive on its own, and it
 * goes away with the process.
 * @param parentPid - `IMAGINE_PARENT_PID`, already parsed.
 * @param onGone - what to do: the boot's own `shutdown`.
 * @returns a disposer, for the tests and for a clean exit.
 */
export function watchParent(parentPid: number, onGone: () => void): () => void {
  let done = false
  const timer = setInterval(() => {
    if (done) return
    if (!parentGone(parentPid, process.ppid, alive)) return
    done = true
    clearInterval(timer)
    console.log(`[imagine] the app that started this studio (pid ${String(parentPid)}) is gone: stopping`)
    onGone()
  }, CHECK_INTERVAL_MS)
  timer.unref()
  return () => { done = true; clearInterval(timer) }
}

/**
 * The pid in `IMAGINE_PARENT_PID`, when it is one.
 * @param env - the environment to read.
 * @returns the pid, or undefined when the variable is absent or not a pid.
 */
export function parentPidFrom(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env['IMAGINE_PARENT_PID']?.trim()
  // Digits only: `parseInt` would take "12x" as 12 and "1.5" as 1, and a wrong
  // pid here stops the studio at once.
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return undefined
  const pid = Number.parseInt(raw, 10)
  return pid > 0 ? pid : undefined
}
